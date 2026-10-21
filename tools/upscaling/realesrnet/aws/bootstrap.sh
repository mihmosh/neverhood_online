#!/bin/bash
set -euo pipefail

install -d -o ubuntu -g ubuntu -m 0750 /opt/neverhood-upscaling
if systemctl cat snap.amazon-ssm-agent.amazon-ssm-agent.service >/dev/null 2>&1; then
  systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service
else
  systemctl enable --now amazon-ssm-agent.service
fi
