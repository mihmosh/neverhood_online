"""Normal (not Sharp) 7B FP8 probe using the pinned upstream registry."""
import sys

import probe


def configure():
    probe.MODEL_VARIANT = '7b'
    probe.MODEL_PRECISION = 'fp8_e4m3fn_mixed_block35_fp16'
    probe.DIT = 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors'
    probe.MODEL_HASHES = {
        probe.DIT: '3d68b5ec0b295ae28092e355c8cad870edd00b817b26587d0cb8f9dd2df19bb2',
        probe.VAE: '20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1',
    }
    probe.RUN_SUFFIX = '-7b'
    probe.RESULT_SUBPREFIX = '7b/'
    probe.BLOCKS_TO_SWAP = 28


def main():
    configure()
    return probe.main()


if __name__ == '__main__':
    sys.exit(main())
