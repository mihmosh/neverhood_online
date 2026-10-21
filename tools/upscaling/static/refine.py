"""Offline, image-guided silhouette refinement; no donor alpha is consumed."""

import numbers

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import breadth_first_order, dijkstra, maximum_flow


_CROSS = ndi.generate_binary_structure(2, 1)


def _topology(mask):
    """Both foreground components and enclosed background use four connectivity."""
    _, components = ndi.label(mask, _CROSS)
    labels, count = ndi.label(~mask, _CROSS)
    exterior = np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1])))
    holes = count - np.count_nonzero(exterior)
    return {"components": int(components), "holes": int(holes)}


def _coverage(mask, samples):
    # Reconstruct the half-grid contour, not a feathered/donor opacity field.
    distance = ndi.distance_transform_edt(mask) - ndi.distance_transform_edt(~mask)
    yy, xx = np.indices(mask.shape, dtype=float)
    coverage = np.zeros(mask.shape, dtype=float)
    for y in (np.arange(samples) + 0.5) / samples - 0.5:
        for x in (np.arange(samples) + 0.5) / samples - 0.5:
            coverage += ndi.map_coordinates(distance, [yy + y, xx + x], order=1,
                                            mode="nearest", prefilter=False) >= 0
    return Image.fromarray(np.rint(coverage * (255 / samples ** 2)).astype(np.uint8))


def _reconnect_exterior(candidate, prior, unknown, cost_fg, cost_bg, band):
    """Reopen only short, source-exterior portals; never fill invented holes.

    A restored wall can bridge a source occlusion gap and enclose a formerly
    exterior opening. Preserve that region's identity through a least-cost
    four-connected path restricted to prior exterior background. This is a
    reviewed source constraint, not evidence of an RGB silhouette at the gap.
    """
    prior_labels, prior_count = ndi.label(~prior, _CROSS)
    exterior_ids = np.unique(np.concatenate((prior_labels[0], prior_labels[-1],
                                             prior_labels[:, 0], prior_labels[:, -1])))
    exterior_ids = exterior_ids[exterior_ids != 0]
    prior_exterior = np.isin(prior_labels, exterior_ids)
    labels, count = ndi.label(~candidate, _CROSS)
    exterior = np.unique(np.concatenate((labels[0], labels[-1], labels[:, 0], labels[:, -1])))
    repaired = candidate.copy()
    corrections = []
    for label in range(1, count + 1):
        if label in exterior:
            continue
        hole = labels == label
        # Existing enclosed holes, split intended holes, and texture cavities
        # wholly inside prior foreground are deliberately NOT repaired here.
        overlap = np.unique(prior_labels[hole])
        overlap = overlap[overlap != 0]
        if not overlap.size or not np.all(np.isin(overlap, exterior_ids)):
            continue
        allowed = prior_exterior & (~repaired | unknown)
        nodes = np.full(candidate.shape, -1, dtype=np.int64)
        nodes[allowed] = np.arange(int(allowed.sum()))
        starts = nodes[hole & allowed]
        border = np.zeros_like(candidate)
        border[0] = border[-1] = True
        border[:, 0] = border[:, -1] = True
        ends = nodes[border & allowed & ~repaired]
        if not starts.size or not ends.size:
            continue
        # Cost counts changed pixels plus their unary RGB/shape disagreement.
        # Positive traversal costs avoid zero-weight sparse-edge ambiguities.
        penalty = np.where(repaired, 1 + np.maximum(cost_bg - cost_fg, 0), 0.001)
        rows, cols, values = [], [], []
        for a, b in ((np.s_[:-1, :], np.s_[1:, :]), (np.s_[:, :-1], np.s_[:, 1:])):
            both = allowed[a] & allowed[b]
            rows.extend((nodes[a][both], nodes[b][both]))
            cols.extend((nodes[b][both], nodes[a][both]))
            weights = (penalty[a][both] + penalty[b][both]) * 0.5
            values.extend((weights, weights))
        graph = coo_matrix((np.concatenate(values), (np.concatenate(rows), np.concatenate(cols))),
                           shape=(int(allowed.sum()),) * 2).tocsr()
        distances, predecessors = dijkstra(graph, directed=False, indices=starts,
                                           min_only=True, return_predecessors=True)[:2]
        end = int(ends[np.argmin(distances[ends])])
        if not np.isfinite(distances[end]):
            continue
        path = []
        vertex = end
        while vertex >= 0:
            path.append(vertex)
            vertex = int(predecessors[vertex])
        flat_nodes = np.flatnonzero(allowed)
        path_pixels = flat_nodes[np.asarray(path)]
        changed = path_pixels[repaired.ravel()[path_pixels]]
        # Do not tear through a substantial rail merely to achieve a count.
        if not changed.size or changed.size > max(1, int(np.ceil(2 * band))):
            continue
        repaired.ravel()[changed] = False
        yy, xx = np.where(hole)
        cy, cx = np.unravel_index(changed, candidate.shape)
        corrections.append({
            "kind": "reopen-source-exterior-portal", "reviewRequired": True,
            "rawHoleArea": int(hole.sum()),
            "rawHoleBoundsXYXY": [int(xx.min()), int(yy.min()), int(xx.max() + 1), int(yy.max() + 1)],
            "removedForegroundPixels": int(changed.size),
            "removedForegroundXY": [[int(x), int(y)] for x, y in zip(cx, cy)],
            "correctionBoundsXYXY": [int(cx.min()), int(cy.min()), int(cx.max() + 1), int(cy.max() + 1)],
            "pathCost": float(distances[end]),
        })
    # Matching a count is insufficient if an intended hole was exchanged for
    # a different cavity. Require distinct enclosed descendants of prior holes.
    if corrections:
        final_labels, _ = ndi.label(~repaired, _CROSS)
        final_exterior = np.unique(np.concatenate((final_labels[0], final_labels[-1],
                                                   final_labels[:, 0], final_labels[:, -1])))
        descendants = set()
        for label in range(1, prior_count + 1):
            if label in exterior_ids:
                continue
            overlap = np.unique(final_labels[prior_labels == label])
            overlap = overlap[overlap != 0]
            if (overlap.size != 1 or overlap[0] in final_exterior
                    or int(overlap[0]) in descendants):
                return candidate.copy(), []
            descendants.add(int(overlap[0]))
    return repaired, corrections


def refine_mask(source_alpha, restored_rgb, scale=4, band_native=3, *,
                shape_weight=0.4, color_weight=6.0, smoothness=1.2,
                edge_sigma=0.08, coverage_samples=4, return_debug_masks=False):
    """Return binaryMask, coverageAlpha, diagnostics, and method metadata.

    Inputs must be PIL L (binary 0/255, native resolution) and PIL RGB (an
    already extracted, exactly scale-sized content crop). Padding/crop origins
    are the caller's responsibility. scale is a positive integer; band_native
    is a positive finite native-pixel radius. All energy weights are finite
    and nonnegative, edge_sigma is positive, coverage_samples is 1..8.

    A four-connected integer s-t cut operates only on the uncertain band.
    Local color models use nearest reliable same-class seeds, with a smoothed
    RGB observation to suppress clay texture. Native distances are linearly
    interpolated at HD pixel centers, never nearest-neighbor upsampled.
    Topology counts are checked, not assumed. Short source-exterior portals
    closed by RGB can be reopened with an explicitly reviewed least-cost path.
    Other failed cuts are rejected to the smooth prior ONLY if it passes.
    Otherwise the failed candidate is returned with reviewRequired=True. Counts cannot
    certify semantic region correspondence or the correctness of an RGB edge.
    coverageAlpha is optional geometric subpixel coverage (None when samples=1),
    not an inferred soft material opacity. Neither input is modified.
    return_debug_masks=True adds rawCandidateMask and priorMask (PIL L).
    The trust band bounds interpolated native-SDF membership, NOT symmetric
    Euclidean distances between raster foreground boundary-pixel centers.
    """
    if not isinstance(source_alpha, Image.Image) or source_alpha.mode != "L":
        raise ValueError("source_alpha must be a PIL L image")
    if not isinstance(restored_rgb, Image.Image) or restored_rgb.mode != "RGB":
        raise ValueError("restored_rgb must be a PIL RGB image")
    if isinstance(scale, bool) or not isinstance(scale, numbers.Integral) or scale < 1:
        raise ValueError("scale must be a positive integer")
    for name, value, positive in (("band_native", band_native, True),
                                  ("shape_weight", shape_weight, False),
                                  ("color_weight", color_weight, False),
                                  ("smoothness", smoothness, False),
                                  ("edge_sigma", edge_sigma, True)):
        if (isinstance(value, bool) or not isinstance(value, numbers.Real)
                or not np.isfinite(value) or value < 0 or (positive and value == 0)):
            raise ValueError(name + " has an invalid bound")
    if (isinstance(coverage_samples, bool) or not isinstance(coverage_samples, numbers.Integral)
            or not 1 <= coverage_samples <= 8):
        raise ValueError("coverage_samples must be an integer in 1..8")
    if not isinstance(return_debug_masks, bool):
        raise ValueError("return_debug_masks must be boolean")
    width, height = source_alpha.size
    if min(width, height) < 1 or restored_rgb.size != (width * scale, height * scale):
        raise ValueError("restored_rgb dimensions must equal native dimensions times scale")
    alpha = np.asarray(source_alpha)
    if not np.all((alpha == 0) | (alpha == 255)):
        raise ValueError("source_alpha must contain only binary 0/255 values")
    source = alpha == 255
    expected_topology = _topology(source)
    baseline = source.repeat(scale, axis=0).repeat(scale, axis=1)
    h, w = baseline.shape
    band = float(band_native * scale)
    reasons = []
    candidate_rejected = False
    cut_topology = None
    node_count = 0
    flow_value = None
    corrections = []
    output_basis = "source-uniform"
    trust_band = np.zeros_like(baseline)
    confidence = np.zeros((h, w), dtype=float)
    rgb = ndi.gaussian_filter(np.asarray(restored_rgb, dtype=float) / 255,
                              sigma=(0.65, 0.65, 0))

    if source.all() or not source.any():
        prior = baseline.copy()
        candidate = prior.copy()
        raw_candidate = candidate.copy()
        unknown = np.zeros_like(prior)
        reasons.append("no-interior-transition")
    else:
        native_distance = (ndi.distance_transform_edt(source)
                           - ndi.distance_transform_edt(~source))
        yy, xx = np.indices((h, w), dtype=float)
        coords = [(yy + 0.5) / scale - 0.5, (xx + 0.5) / scale - 0.5]
        distance = ndi.map_coordinates(native_distance, coords, order=1,
                                       mode="nearest", prefilter=False) * scale
        prior = distance >= 0
        unknown = np.abs(distance) < band
        trust_band = unknown.copy()

        # A bitmap cut edge is not an observed silhouette. Lock border runs
        # except near genuine transitions along that same border.
        for border, fixed, values in ((prior[0], unknown[0], baseline[0]),
                                       (prior[-1], unknown[-1], baseline[-1]),
                                       (prior[:, 0], unknown[:, 0], baseline[:, 0]),
                                       (prior[:, -1], unknown[:, -1], baseline[:, -1])):
            transitions = np.zeros(values.shape, dtype=bool)
            transitions[1:] |= values[1:] != values[:-1]
            transitions[:-1] |= values[1:] != values[:-1]
            allowed = (ndi.distance_transform_edt(~transitions) <= band
                       if transitions.any() else np.zeros_like(values))
            fixed[~allowed] = False
            border[~allowed] = values[~allowed]

        # Thin regions/holes may have no band-deep seed. Add a single interior
        # center per such component, rather than eroding the region away.
        for state in (True, False):
            labels, count = ndi.label(prior == state, _CROSS)
            seeded = np.unique(labels[(prior == state) & ~unknown])
            objects = ndi.find_objects(labels)
            for label in np.setdiff1d(np.arange(1, count + 1), seeded):
                region = objects[label - 1]
                local = labels[region] == label
                depth = ndi.distance_transform_edt(np.pad(local, 1))[1:-1, 1:-1]
                cy, cx = np.unravel_index(np.argmax(depth), depth.shape)
                unknown[region[0].start + cy, region[1].start + cx] = False

        models = []
        for state in (True, False):
            seeds = (prior == state) & ~unknown
            if not seeds.any():
                raise ValueError("smooth prior lost a source region; reduce band or inspect source")
            nearest = ndi.distance_transform_edt(~seeds, return_distances=False, return_indices=True)
            models.append(rgb[tuple(nearest)])
        fg, bg = models
        separation = np.sum((fg - bg) ** 2, axis=2)
        confidence = np.clip(np.sqrt(separation) / 0.18, 0, 1)
        denom = separation + 0.01
        cost_fg = color_weight * confidence * np.minimum(np.sum((rgb - fg) ** 2, axis=2) / denom, 4)
        cost_bg = color_weight * confidence * np.minimum(np.sum((rgb - bg) ** 2, axis=2) / denom, 4)
        cost_fg += shape_weight * np.maximum(-distance / band, 0)
        cost_bg += shape_weight * np.maximum(distance / band, 0)
        node_count = int(unknown.sum())
        if node_count and np.max(confidence[unknown]) > 0.05:
            ids = np.full((h, w), -1, dtype=np.int64)
            ids[unknown] = np.arange(node_count)
            rows, cols, capacities = [], [], []

            def add(a, b, c):
                scaled = np.rint(np.asarray(c).ravel() * 1024)
                if not np.all(np.isfinite(scaled)) or np.any(scaled > 2 ** 30):
                    raise ValueError("energy weights exceed integer capacity bounds")
                rows.append(np.asarray(a).ravel())
                cols.append(np.asarray(b).ravel())
                capacities.append(scaled.astype(np.int64))

            for a, b in ((np.s_[:-1, :], np.s_[1:, :]), (np.s_[:, :-1], np.s_[:, 1:])):
                contrast = np.sum((rgb[a] - rgb[b]) ** 2, axis=2)
                weights = smoothness * (0.03 + np.exp(-contrast / (2 * edge_sigma ** 2)))
                both = unknown[a] & unknown[b]
                add(ids[a][both], ids[b][both], weights[both])
                add(ids[b][both], ids[a][both], weights[both])
                for here, there in ((a, b), (b, a)):
                    boundary = unknown[here] & ~unknown[there]
                    cost_fg[here] += weights * boundary * ~prior[there]
                    cost_bg[here] += weights * boundary * prior[there]
            source_id, sink_id = node_count, node_count + 1
            add(np.full(node_count, source_id), ids[unknown], cost_bg[unknown])
            add(ids[unknown], np.full(node_count, sink_id), cost_fg[unknown])
            graph = coo_matrix((np.concatenate(capacities),
                                (np.concatenate(rows), np.concatenate(cols))),
                               shape=(node_count + 2, node_count + 2)).tocsr()
            graph.eliminate_zeros()
            flow = maximum_flow(graph, source_id, sink_id)
            residual = graph - flow.flow
            residual.data = (residual.data > 0).astype(np.int64)
            residual.eliminate_zeros()
            reachable = breadth_first_order(residual, source_id, directed=True,
                                            return_predecessors=False)
            selected = np.zeros(node_count + 2, dtype=bool)
            selected[reachable] = True
            candidate = prior.copy()
            candidate[unknown] = selected[:node_count]
            flow_value = int(flow.flow_value)
        else:
            candidate = prior.copy()
        output_basis = "rgb-graph-cut" if flow_value is not None else "smooth-prior-no-rgb-evidence"
        cut_topology = _topology(candidate)
        raw_candidate = candidate.copy()
        if cut_topology != expected_topology:
            candidate_rejected = True
            reasons.append("graph-cut-topology-mismatch")
            if (_topology(prior) == expected_topology and flow_value is not None
                    and cut_topology["components"] == expected_topology["components"]
                    and cut_topology["holes"] > expected_topology["holes"]):
                repaired, proposals = _reconnect_exterior(candidate, prior, unknown,
                                                         cost_fg, cost_bg, band)
                if proposals and _topology(repaired) == expected_topology:
                    candidate, corrections = repaired, proposals
                    output_basis = "rgb-graph-cut-with-reviewed-exterior-reconnection"
                    reasons.append("source-exterior-connectivity-restored-review-required")
            if not corrections and _topology(prior) == expected_topology:
                candidate = prior.copy()
                output_basis = "smooth-prior"
                reasons.append("smooth-prior-returned-not-image-approved")

    topology = _topology(candidate)
    topology_ok = topology == expected_topology
    if not topology_ok:
        reasons.append("output-topology-mismatch")
    # Evaluate only interior contour edges, never the rectangular crop edge.
    supports, confidences = [], []
    for a, b in ((np.s_[:-1, :], np.s_[1:, :]), (np.s_[:, :-1], np.s_[:, 1:])):
        boundary = candidate[a] != candidate[b]
        strength = np.sqrt(np.sum((rgb[a] - rgb[b]) ** 2, axis=2))
        supports.extend(strength[boundary].tolist())
        confidences.extend(((confidence[a] + confidence[b]) * 0.5)[boundary].tolist())
    edge_support = float(np.mean(np.asarray(supports) >= 0.04)) if supports else 0.0
    color_confidence = float(np.mean(confidences)) if confidences else 0.0
    if edge_support < 0.25 or color_confidence < 0.2:
        reasons.append("ambiguous-or-unsupported-rgb-boundary")
    boundary = candidate ^ ndi.binary_erosion(candidate, structure=_CROSS, border_value=1)
    baseline_boundary = baseline ^ ndi.binary_erosion(baseline, structure=_CROSS, border_value=1)
    displacement = (ndi.distance_transform_edt(~baseline_boundary)[boundary]
                    if boundary.any() and baseline_boundary.any() else np.array([0.0]))
    reverse = (ndi.distance_transform_edt(~boundary)[baseline_boundary]
               if boundary.any() and baseline_boundary.any() else np.array([0.0]))
    changed = candidate != baseline
    beyond = changed & ~trust_band
    if beyond.any():
        reasons.append("changed-outside-trust-band")
    diagnostics = {
        "verdict": "review-required" if reasons else "rgb-supported-candidate",
        "automaticApproval": False,
        "reviewRequired": bool(reasons), "reviewReasons": reasons,
        "topologyPreserved": topology_ok, "sourceTopology": expected_topology,
        "candidateTopology": cut_topology, "outputTopology": topology,
        "candidateRejected": candidate_rejected, "unknownPixels": node_count,
        "candidateCorrected": bool(corrections), "topologyCorrections": corrections,
        "outputBasis": output_basis,
        "flowValue": flow_value, "bandHD": band,
        "trustBandDefinition": "absolute interpolated native signed distance < bandHD",
        "edgeSupportFraction": edge_support, "colorConfidence": color_confidence,
        "displacementHD": {"hardBound": False,
                           "definition": "Euclidean foreground boundary-pixel-center distances to source NN; max is symmetric",
                           "maxExceedsBandHD": bool(max(displacement.max(), reverse.max()) > band),
                           "mean": float(displacement.mean()),
                           "p95": float(np.percentile(displacement, 95)),
                           "maxSymmetric": float(max(displacement.max(), reverse.max()))},
        "changedPixels": int(changed.sum()), "changedOutsideTrustBand": int(beyond.sum()),
    }
    result = {
        "binaryMask": Image.fromarray(candidate.astype(np.uint8) * 255),
        "coverageAlpha": _coverage(candidate, coverage_samples) if coverage_samples > 1 else None,
        "diagnostics": diagnostics,
        "method": "local-seed-rgb-narrowband-integer-graph-cut",
        "coverageMethod": "supersampled-half-grid-contour" if coverage_samples > 1 else None,
    }
    if return_debug_masks:
        result["rawCandidateMask"] = Image.fromarray(raw_candidate.astype(np.uint8) * 255)
        result["priorMask"] = Image.fromarray(prior.astype(np.uint8) * 255)
    return result
