#!/usr/bin/env python3
"""清理抠图：只删微小噪点，保留所有连通域

⚠️ 不要用"保留最大连通域"逻辑——四条腿和尾巴在 alpha 上往往是分离的
连通域，删掉非最大域会把腿/尾巴当噪点砍掉（踩坑实录 #3 的铁律）。

默认只删 <500px 的微小噪点（分割残留的小背景块）。

依赖：numpy, Pillow, scipy
用法：
    python clean_cutout.py --input <cutout_dir> --output <clean_dir> [--min-size 500]
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def clean(img: Image.Image, min_size: int = 500) -> Image.Image:
    """删掉面积 < min_size 的连通域，其余全部保留"""
    a = np.asarray(img)[:, :, 3]
    mask = a > 10
    if mask.sum() == 0:
        return img
    lab, n = ndimage.label(mask)
    if n <= 1:
        return img
    sizes = ndimage.sum_labels(mask, lab, index=range(1, n + 1))  # E-2: 新版 API（scipy 1.17+；sum 已被官方建议替换）
    # sizes[i] 对应 label i+1；只删小于阈值的
    drop = set(np.where(sizes < min_size)[0] + 1)
    if not drop:
        return img
    a = a.copy()
    for k in drop:
        a[lab == k] = 0
    arr = np.asarray(img).copy()
    arr[:, :, 3] = a
    return Image.fromarray(arr)


def main() -> None:
    parser = argparse.ArgumentParser(description='清理抠图噪点（保留所有连通域）')
    parser.add_argument('--input', required=True, help='抠图目录（RGBA）')
    parser.add_argument('--output', required=True, help='清理输出目录')
    parser.add_argument('--min-size', type=int, default=500, help='噪点面积阈值（默认 500px）')
    args = parser.parse_args()

    if not os.path.isdir(args.input):
        print(f'错误: 输入目录不存在: {args.input}', file=sys.stderr)
        sys.exit(1)
    if args.min_size <= 0:
        print(f'错误: --min-size 必须为正整数，收到 {args.min_size}', file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)
    frames = sorted(f for f in os.listdir(args.input) if f.endswith('.png'))
    for f in frames:
        img = Image.open(os.path.join(args.input, f))
        clean(img, args.min_size).save(os.path.join(args.output, f))
    print(f'清理完成 {len(frames)} 帧')


if __name__ == '__main__':
    main()
