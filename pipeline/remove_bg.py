#!/usr/bin/env python3
"""rembg 抠图：selected/*.png → cutout/*.png（透明背景）

使用语义分割（rembg），不是色度抠图——白毛 vs 浅色背景色差小，
色度抠图会把白毛删成半透明（踩坑实录 #2 的铁律）。

依赖：rembg, Pillow（首次运行会自动下载分割模型）
用法：
    python remove_bg.py --input <selected_dir> --output <cutout_dir> [--model u2net] [--alpha-matting]
"""
import argparse
import os
import sys

from PIL import Image
from rembg import remove


def main():
    parser = argparse.ArgumentParser(description='rembg 语义分割抠图')
    parser.add_argument('--input', required=True, help='选中帧目录')
    parser.add_argument('--output', required=True, help='抠图输出目录（RGBA）')
    parser.add_argument('--model', default='u2net',
                        help='分割模型（u2net / isnet-general-use / silueta 等，默认 u2net；毛发边缘问题可换 isnet-general-use）')
    parser.add_argument('--alpha-matting', action='store_true',
                        help='启用 alpha matting（毛发边缘细化，处理白毛/边缘虚化问题）')
    args = parser.parse_args()

    if not os.path.isdir(args.input):
        print(f'错误: 输入目录不存在: {args.input}', file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)
    frames = sorted(f for f in os.listdir(args.input) if f.endswith('.png'))
    if not frames:
        print(f'错误: 输入目录没有 PNG 文件: {args.input}', file=sys.stderr)
        sys.exit(1)

    kwargs = {'model_name': args.model}
    if args.alpha_matting:
        kwargs['alpha_matting'] = True

    for i, f in enumerate(frames):
        src = os.path.join(args.input, f)
        # A-9: 保留原始 stem，方便回溯（c_<原帧名>.png）
        stem = os.path.splitext(f)[0]
        dst = os.path.join(args.output, f'c_{stem}.png')
        img = Image.open(src)
        out = remove(img, **kwargs)  # RGBA 透明
        out.save(dst)
        print(f'{f} → c_{stem}.png ({out.size})')
    print(f'抠图完成 {len(frames)} 帧')


if __name__ == '__main__':
    main()
