"""Inference-only native x4 RRDBNet; no BasicSR import, downloads, or alpha inference.

Architecture adapted from BasicSR rrdbnet_arch.py (8d56e3a), Copyright
2018-2022 BasicSR Authors, Apache-2.0:
https://github.com/XPixelGroup/BasicSR/blob/8d56e3a045f9fb3e1d8872f92ee4a4f07f886b0a/LICENSE.txt
Changes: fixed x4/64-feature/23-block/32-growth inference-only network, removed
registry/training/init helpers, lazy Torch import, local verified checkpoint.
Preprocessing follows sibling neural_sprite.py / gpu_sprite_smoke.py.
Reflect-padding/cropping follows Real-ESRGAN realesrgan/utils.py, Copyright
(c) 2021, Xintao Wang, BSD 3-Clause:
https://github.com/xinntao/Real-ESRGAN/blob/v0.3.0/LICENSE
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
"""

import hashlib

import numpy as np
from PIL import Image
from scipy import ndimage

MODEL_SHA256 = 'a820b9bde89a874d7599d545567308ce6c128fc8754a53208eda016d40aa81df'


def prepare_rgb(image):
    """Extend tiny frames to 9px before nearest foreground fill, then reflect 8.

    Fully transparent inputs return None: their canonical output is all zero
    RGBA, without loading or invoking a neural model.
    """
    extended = Image.new('RGBA', (max(9, image.width), max(9, image.height)))
    extended.paste(image, (0, 0))
    rgba = np.asarray(extended)
    visible = rgba[:, :, 3] != 0
    if not visible.any():
        return None
    indices = ndimage.distance_transform_edt(~visible, return_distances=False, return_indices=True)
    rgb = rgba[:, :, :3].copy()
    rgb[~visible] = rgb[tuple(indices[:, ~visible])]
    return np.pad(rgb, ((8, 8), (8, 8), (0, 0)), mode='reflect')


def attach_mask(rgb, source):
    alpha = np.asarray(source.getchannel('A').resize(
        (source.width * 4, source.height * 4), Image.Resampling.NEAREST))
    rgba = np.empty((source.height * 4, source.width * 4, 4), dtype=np.uint8)
    rgba[:, :, :3] = rgb[:source.height * 4, :source.width * 4]
    rgba[:, :, 3] = alpha
    rgba[alpha == 0, :3] = 0
    return Image.fromarray(rgba, 'RGBA')


def build_network(torch):
    nn, F = torch.nn, torch.nn.functional

    class ResidualDenseBlock(nn.Module):
        def __init__(self):
            super().__init__()
            for i in range(1, 6):
                setattr(self, f'conv{i}', nn.Conv2d(64 + (i - 1) * 32,
                        32 if i < 5 else 64, 3, 1, 1))

        def forward(self, x):
            features = [x]
            for i in range(1, 5):
                features.append(F.leaky_relu(getattr(self, f'conv{i}')(
                    torch.cat(features, 1)), .2, inplace=True))
            return self.conv5(torch.cat(features, 1)) * .2 + x

    class RRDB(nn.Module):
        def __init__(self):
            super().__init__()
            self.rdb1, self.rdb2, self.rdb3 = (ResidualDenseBlock() for _ in range(3))

        def forward(self, x):
            return self.rdb3(self.rdb2(self.rdb1(x))) * .2 + x

    class RRDBNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.conv_first = nn.Conv2d(3, 64, 3, 1, 1)
            self.body = nn.Sequential(*(RRDB() for _ in range(23)))
            self.conv_body = nn.Conv2d(64, 64, 3, 1, 1)
            self.conv_up1 = nn.Conv2d(64, 64, 3, 1, 1)
            self.conv_up2 = nn.Conv2d(64, 64, 3, 1, 1)
            self.conv_hr = nn.Conv2d(64, 64, 3, 1, 1)
            self.conv_last = nn.Conv2d(64, 3, 3, 1, 1)

        def forward(self, x):
            first = self.conv_first(x)
            x = first + self.conv_body(self.body(first))
            x = F.leaky_relu(self.conv_up1(F.interpolate(x, scale_factor=2,
                             mode='nearest')), .2, inplace=True)
            x = F.leaky_relu(self.conv_up2(F.interpolate(x, scale_factor=2,
                             mode='nearest')), .2, inplace=True)
            return self.conv_last(F.leaky_relu(self.conv_hr(x), .2, inplace=True))

    return RRDBNet()


def load_weights(torch, network, checkpoint, expected_sha=MODEL_SHA256):
    digest = hashlib.sha256()
    with open(checkpoint, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha:
        raise ValueError('Checkpoint SHA256 mismatch; refusing torch.load')
    weights = torch.load(checkpoint, map_location='cpu', weights_only=True)
    parameters = weights['params_ema'] if 'params_ema' in weights else weights['params']
    network.load_state_dict(parameters, strict=True)


class Processor:
    def __init__(self, checkpoint):
        self.checkpoint, self.network, self.torch = checkpoint, None, None

    def __call__(self, image):
        rgb = prepare_rgb(image)
        if rgb is None:
            return Image.new('RGBA', (image.width * 4, image.height * 4)), {
                'transparent_fastpath': True, 'peak_allocated_bytes': 0,
                'peak_reserved_bytes': 0}
        if self.network is None:
            import torch
            if torch.__version__ != '2.7.1+cu126' or not torch.cuda.is_available():
                raise RuntimeError('Requires existing Torch 2.7.1+cu126 CUDA environment')
            torch.backends.cuda.matmul.allow_tf32 = False
            torch.backends.cudnn.allow_tf32 = False
            torch.backends.cudnn.deterministic = True
            torch.backends.cudnn.benchmark = False
            torch.use_deterministic_algorithms(True)
            torch.manual_seed(0)
            torch.set_num_threads(1)
            network = build_network(torch)
            load_weights(torch, network, self.checkpoint)
            self.network = network.eval().to(device='cuda:0', dtype=torch.float32)
            self.torch = torch
        torch = self.torch
        torch.cuda.reset_peak_memory_stats()
        tensor = torch.from_numpy(rgb.astype(np.float32).transpose(2, 0, 1).copy() / 255)
        tensor = tensor.unsqueeze(0).to(device='cuda:0', dtype=torch.float32)
        with torch.inference_mode():
            result = self.network(tensor)[0, :, 32:-32, 32:-32].clamp(0, 1)
            result = result.float().cpu().numpy().transpose(1, 2, 0)
        if not np.isfinite(result).all():
            raise ValueError('Nonfinite model output')
        output = attach_mask(np.rint(result * 255).astype(np.uint8), image)
        return output, {'transparent_fastpath': False,
            'peak_allocated_bytes': torch.cuda.max_memory_allocated(),
            'peak_reserved_bytes': torch.cuda.max_memory_reserved()}

    def close(self):
        self.network = None
        if self.torch is not None:
            self.torch.cuda.empty_cache()
