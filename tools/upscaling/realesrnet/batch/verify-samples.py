"""Validate downloaded S3 PNG bodies against original local binary masks."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--work-dir', type=Path, required=True)
args = parser.parse_args()
work = args.work_dir.resolve()
record = json.loads((work / 'sample-downloads.json').read_text())
checked = []
for entry in record['files']:
    source_path = work / entry['input_path']
    data = Path(entry['downloaded_path']).read_bytes()
    if hashlib.sha256(source_path.read_bytes()).hexdigest() != entry['input_sha256'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise ValueError('Sample/source checksum changed')
    with Image.open(source_path) as source, Image.open(entry['downloaded_path']) as output:
        source.load()
        output.load()
        if output.format != 'PNG' or output.mode != 'RGBA' or output.size != (entry['width'] * 4, entry['height'] * 4):
            raise ValueError('Sample output geometry/format mismatch')
        expected_alpha = np.asarray(source.getchannel('A').resize(output.size, Image.Resampling.NEAREST))
        rgba = np.asarray(output)
        if not np.array_equal(rgba[:, :, 3], expected_alpha) or set(np.unique(rgba[:, :, 3])) - {0, 255} or np.any(rgba[expected_alpha == 0, :3]):
            raise ValueError('Sample alpha/hidden RGB contract failed')
        checked.append({'jobKey': entry['job_key'], 'sha256': entry['sha256'], 'size': list(output.size), 'binaryAlphaExact': True})
result = {'passed': True, 'sampleCount': len(checked), 'sampling': '20 fixed-seed random plus native minimum/maximum', 'files': checked, 'localOnly': True}
(work / 'sample-validation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'passed': True, 'samples': len(checked), 'sourceMasksExact': True, 'downloadedBodiesSHA256Verified': True}))
