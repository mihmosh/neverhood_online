# Shareable Configuration

[seedvr2-probe-v1.json](../realesrnet/configs/seedvr2-probe-v1.json) records actual non-secret settings
and outcomes. It is an experiment record, not a runnable deployment manifest.
[manifest.md](manifest.md) defines the proposed common asset contract.

Future executable configurations must distinguish:

- Source and output identifiers, hashes and geometry.
- Model weights, runner revision and precision/quantization.
- Exposed parameters versus provider defaults that cannot be controlled.
- Processing timeline versus original gameplay timing.
- Formal validation versus heuristic review versus explicit approval.

Keep paths configurable and credentials in environment variables. Never embed
tokens, signed download URLs, base64 source media or raw API response objects.
An environment-variable name is shareable; its value is not.
