#!/usr/bin/env python3
"""rembg 抠图：selected/*.png → cutout/*.png（透明背景）

使用语义分割（rembg），不是色度抠图——白毛 vs 浅色背景色差小，
色度抠图会把白毛删成半透明（踩坑实录 #2 的铁律）。

依赖：rembg, Pillow（首次运行会自动下载分割模型）
用法：
    python remove_bg.py --input <selected_dir> --output <cutout_dir>
"""
import argparse
import os

from PIL import Image
from rembg import remove


def main():
    parser = argparse.ArgumentParser(description='rembg 语义分割抠图')
    parser.add_argument('--input', required=True, help='选中帧目录')
    parser.add_argument('--output', required=True, help='抠图输出目录（RGBA）')
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    frames = sorted(f for f in os.listdir(args.input) if f.endswith('.png'))
    for i, f in enumerate(frames):
        src = os.path.join(args.input, f)
        dst = os.path.join(args.output, f'c_{i:02d}.png')
        img = Image.open(src)
        out = remove(img)  # RGBA 透明
        out.save(dst)
        print(f'{f} → c_{i:02d}.png ({out.size})')
    print(f'抠图完成 {len(frames)} 帧')


if __name__ == '__main__':
    main()
