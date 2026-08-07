#!/usr/bin/env python3
"""裁切对齐 + 精灵表合成

- 每帧按 alpha bbox 裁剪 → 统一画布居中 → 合成横排精灵表
- 输出为 RGBA 横排精灵表，帧 i 位于 x=[i*cell, (i+1)*cell)

⚠️ WebGL 纹理硬上限：总宽 = cell × 帧数 ≤ 16384px（踩坑实录 #1 的铁律）。

依赖：numpy, Pillow
用法：
    python make_sheet.py --input <clean_dir> --output <out_dir> [--cell 1024] [--pad 0.06] [--name mysheet.png]
"""
import argparse
import os

import numpy as np
from PIL import Image


def alpha_bbox(img):
    a = np.asarray(img)[:, :, 3]
    ys, xs = np.where(a > 10)
    if len(xs) == 0:
        return None
    return xs.min(), ys.min(), xs.max(), ys.max()


def make_sheet(input_dir, out_dir, cell=1024, pad_ratio=0.06, name=None):
    os.makedirs(out_dir, exist_ok=True)
    frames = sorted(f for f in os.listdir(input_dir) if f.endswith('.png'))
    if not frames:
        raise RuntimeError(f'输入目录为空: {input_dir}')

    imgs = [Image.open(os.path.join(input_dir, f)) for f in frames]

    # 1. 计算所有帧的 bbox
    boxes = [alpha_bbox(img) for img in imgs]

    # 2. 统一目标尺寸：取所有 bbox 的最大宽高（含边距），上限 cell
    ws = [b[2] - b[0] for b in boxes if b]
    hs = [b[3] - b[1] for b in boxes if b]
    max_w, max_h = max(ws), max(hs)
    pad = int(max(max_w, max_h) * pad_ratio)
    target = min(max(max_w, max_h) + pad * 2, cell)

    frames_out = []
    for img, box in zip(imgs, boxes):
        if box is None:
            canvas = Image.new('RGBA', (target, target), (0, 0, 0, 0))
            frames_out.append(canvas)
            continue
        x0, y0, x1, y1 = box
        crop = img.crop((x0, y0, x1, y1))
        # 等比缩放到 target-pad*2
        scale = (target - pad * 2) / max(crop.size)
        if scale < 1:
            crop = crop.resize((int(crop.width * scale), int(crop.height * scale)), Image.LANCZOS)
        canvas = Image.new('RGBA', (target, target), (0, 0, 0, 0))
        canvas.paste(crop, ((target - crop.width) // 2, (target - crop.height) // 2), crop)
        frames_out.append(canvas)

    # 3. 纹理上限检查
    total_w = target * len(frames_out)
    if total_w > 16384:
        print(f'⚠️  总宽 {total_w}px 超过 WebGL 纹理上限 16384px——'
              f'请减少帧数或缩小 cell（帧数×cell ≤ 16384）')
        raise SystemExit(1)

    # 4. 合成横排精灵表
    sheet = Image.new('RGBA', (total_w, target), (0, 0, 0, 0))
    for i, f in enumerate(frames_out):
        sheet.paste(f, (i * target, 0), f)
    out_path = os.path.join(out_dir, name or f'{os.path.basename(os.path.normpath(input_dir))}_sheet.png')
    sheet.save(out_path)
    print(f'精灵表: {sheet.size}, {len(frames_out)} 帧, cell={target}x{target}')
    print(f'输出: {out_path}')
    return target


def main():
    parser = argparse.ArgumentParser(description='裁切对齐并合成精灵表')
    parser.add_argument('--input', required=True, help='清理后帧目录（RGBA）')
    parser.add_argument('--output', required=True, help='精灵表输出目录')
    parser.add_argument('--cell', type=int, default=1024, help='单元格上限（默认 1024）')
    parser.add_argument('--pad', type=float, default=0.06, help='bbox 边距比例（默认 0.06）')
    parser.add_argument('--name', default=None, help='输出文件名（默认 <输入目录名>_sheet.png）')
    args = parser.parse_args()

    make_sheet(args.input, args.output, args.cell, args.pad, args.name)


if __name__ == '__main__':
    main()
