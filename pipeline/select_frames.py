#!/usr/bin/env python3
"""PetPet 视频帧去重精修：从抽帧中选择 N 个"真姿势"帧

策略：时间分区 + 区间内最大差异 + 相邻去重
- 时间分区：把视频时长均分 N 段，每段选与段首差异最大的帧（保证覆盖全程）
- 相邻去重：差异 < min_diff 的相邻帧只留前者（去掉几乎相同的帧）
- 剔除过多时从被剔除帧里均匀补回

依赖：numpy, Pillow
用法：
    python select_frames.py --input <frames_dir> --output <out_dir> --frames 12
"""
import argparse
import os
import shutil
import sys

import numpy as np
from PIL import Image


def frame_diff(a, b):
    """两帧差异度（0~1），缩略图比较"""
    ta = np.asarray(a.resize((96, 96), Image.BILINEAR), dtype=np.float32)
    tb = np.asarray(b.resize((96, 96), Image.BILINEAR), dtype=np.float32)
    return float(np.mean(np.abs(ta - tb)) / 255.0)


def select_frames(frames_dir, target_n, min_diff=0.02):
    """从帧目录选 target_n 帧，返回帧文件列表（有序）"""
    frames = sorted(f for f in os.listdir(frames_dir) if f.endswith('.png'))
    if len(frames) <= target_n:
        return frames
    imgs = {f: Image.open(os.path.join(frames_dir, f)) for f in frames}
    names = frames

    # 1. 时间分区：target_n 个区间，每区间取与区间起点差异最大的帧
    picks = []
    n = len(names)
    for i in range(target_n):
        start = i * n // target_n
        end = (i + 1) * n // target_n
        if end <= start:
            end = start + 1
        base = imgs[names[start]]
        best_f, best_d = names[start], 0
        for j in range(start, min(end, n)):
            d = frame_diff(base, imgs[names[j]])
            if d > best_d:
                best_d, best_f = d, names[j]
        picks.append(best_f)

    # 2. 相邻去重：差异 < min_diff 的相邻对，剔除后者（保前者）
    out = [picks[0]]
    for p in picks[1:]:
        if frame_diff(imgs[out[-1]], imgs[p]) >= min_diff:
            out.append(p)
    # 3. 若剔除过多，从被剔除里补回（均匀补）
    if len(out) < target_n:
        need = target_n - len(out)
        rest = [p for p in picks if p not in out]
        step = max(1, len(rest) // need)
        for k in range(0, len(rest), step):
            if len(out) >= target_n:
                break
            if rest[k] not in out:
                out.append(rest[k])
    out.sort(key=lambda f: names.index(f))  # A-2: 按原抽帧顺序排（不解析文件名，避免非 xxx_NNN.png 命名崩溃）
    return out[:target_n]


def main():
    parser = argparse.ArgumentParser(description='从抽帧中选择 N 个真姿势帧')
    parser.add_argument('--input', required=True, help='抽帧目录（PNG）')
    parser.add_argument('--output', required=True, help='选中帧输出目录')
    parser.add_argument('--frames', type=int, required=True, help='目标帧数')
    parser.add_argument('--min-diff', type=float, default=0.02, help='相邻去重阈值（默认 0.02）')
    parser.add_argument('--clean', action='store_true', help='清空输出目录（默认只清理 p_*.png 产物）')
    args = parser.parse_args()

    if not os.path.isdir(args.input):
        print(f'错误: 输入目录不存在: {args.input}', file=sys.stderr)
        sys.exit(1)
    if args.frames <= 0:
        print(f'错误: --frames 必须为正整数，收到 {args.frames}', file=sys.stderr)
        sys.exit(1)
    if args.min_diff < 0 or args.min_diff > 1:
        print(f'错误: --min-diff 应在 0~1 之间，收到 {args.min_diff}', file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)
    # A-1: 默认只删本脚本的产物 p_*.png；--clean 才清空整个目录（防误删用户文件）
    for f in os.listdir(args.output):
        fp = os.path.join(args.output, f)
        if args.clean or f.startswith('p_'):
            if os.path.isfile(fp):
                os.remove(fp)
        else:
            print(f'警告: 输出目录含非产物文件（保留）: {f}', file=sys.stderr)

    picks = select_frames(args.input, args.frames, args.min_diff)
    for i, f in enumerate(picks):
        shutil.copy(os.path.join(args.input, f), os.path.join(args.output, f'p_{i:03d}.png'))  # A-6: 三位序号防字典序错乱

    print(f'选择 {len(picks)} 帧: {[p.replace(".png", "") for p in picks]}')
    imgs = [Image.open(os.path.join(args.output, f'p_{i:03d}.png')) for i in range(len(picks))]
    print('差异度: ', end='')
    for i in range(1, len(imgs)):
        print(f'{frame_diff(imgs[i - 1], imgs[i]):.3f}', end=' ')
    print()


if __name__ == '__main__':
    main()
