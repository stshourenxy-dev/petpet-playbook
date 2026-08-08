#!/usr/bin/env python3
"""管线冒烟测试：验证 4 个脚本可运行 + 关键铁律生效

运行: python tests/smoke_test.py
覆盖:
  1. select_frames 20 帧 → 12 帧
  2. clean_cutout 清理通过
  3. make_sheet 合成精灵表尺寸正确
  4. 纹理上限拦截: 17帧×1024 = 17408 > 16384 → 拒绝 (退出码 1)
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIPE = os.path.join(ROOT, 'pipeline')


def make_frames(n, size=128):
    """造 n 帧：白底 + 黑色方块水平移动（模拟动作）"""
    d = tempfile.mkdtemp(prefix='smoke_frames_')
    step = max(1, size // n)
    for i in range(n):
        img = Image.new('RGBA', (size, size), (255, 255, 255, 255))
        dr = ImageDraw.Draw(img)
        x = i * step
        dr.rectangle([x, size // 3, x + size // 4, size * 2 // 3], fill=(50, 50, 50, 255))
        img.save(os.path.join(d, f'f_{i:02d}.png'))
    return d


def run(script, *args, expect_rc=0):
    r = subprocess.run(
        [sys.executable, os.path.join(PIPE, script), *args],
        capture_output=True, text=True,
        check=False,  # 预期失败场景需要检查返回码而非异常
    )
    assert r.returncode == expect_rc, (
        f'{script} 退出码 {r.returncode} (期望 {expect_rc}): {r.stderr}')
    return r


def test_pipeline_ok():
    frames = make_frames(20)
    sel, clean, out = tempfile.mkdtemp(), tempfile.mkdtemp(), tempfile.mkdtemp()
    try:
        run('select_frames.py', '--input', frames, '--output', sel, '--frames', '12')
        assert len(os.listdir(sel)) == 12, 'select_frames 应输出 12 帧'
        run('clean_cutout.py', '--input', sel, '--output', clean)
        assert len(os.listdir(clean)) == 12, 'clean_cutout 应保留 12 帧'
        run('make_sheet.py', '--input', clean, '--output', out,
            '--name', 'ok.png', '--cell', '128')
        sheet = Image.open(os.path.join(out, 'ok.png'))
        assert sheet.size == (128 * 12, 128), f'精灵表尺寸错误: {sheet.size}'
        print('✅ 管线 20→12 帧 → 清理 → 精灵表 (1536x128) OK')
    finally:
        for d in (frames, sel, clean, out):
            shutil.rmtree(d, ignore_errors=True)


def test_texture_limit():
    # 内容为 1024px 的帧：target=1024, 17×1024=17408 > 16384 → 必须拒绝
    frames = make_frames(17, size=1024)
    out = tempfile.mkdtemp()
    try:
        run('make_sheet.py', '--input', frames, '--output', out, '--cell', '1024',
            expect_rc=1)
        print('✅ 纹理上限拦截：17×1024=17408 > 16384 → 正确拒绝')
    finally:
        shutil.rmtree(frames, ignore_errors=True)
        shutil.rmtree(out, ignore_errors=True)


if __name__ == '__main__':
    test_pipeline_ok()
    test_texture_limit()
    print('\n🎉 全部冒烟测试通过')
