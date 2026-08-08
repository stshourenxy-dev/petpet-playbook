#!/usr/bin/env python3
"""管线单元测试（pytest）：覆盖 select_frames / clean_cutout / make_sheet 边界情况

运行: pip install pytest && pytest tests/ -v
覆盖:
  - select_frames: 正常选帧 / 帧数不足 / 全相同帧补回
  - clean_cutout: 保留分离连通域（腿/尾巴铁律）/ 删小噪点 / 全透明不崩
  - make_sheet: 空目录报错 / 全透明帧警告 / 纹理上限拦截
"""
import os
import shutil
import sys
import tempfile

import numpy as np
import pytest
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'pipeline'))

from clean_cutout import clean
from make_sheet import make_sheet
from select_frames import select_frames


def make_frames(n, size=128, move=True):
    """造 n 帧白底帧（与 smoke_test 一致）：黑块水平移动模拟动作"""
    d = tempfile.mkdtemp(prefix='test_frames_')
    step = max(1, size // max(n, 1))
    for i in range(n):
        img = Image.new('RGBA', (size, size), (255, 255, 255, 255))
        dr = ImageDraw.Draw(img)
        x = i * step if move else size // 3
        dr.rectangle([x, size // 3, x + size // 4, size * 2 // 3],
                     fill=(50, 50, 50, 255))
        img.save(os.path.join(d, f'f_{i:02d}.png'))
    return d


class TestSelectFrames:
    def test_normal_20_to_12(self):
        d = make_frames(20)
        try:
            assert len(select_frames(d, 12)) == 12
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_nonstandard_names(self):
        # B-3: 非 xxx_NNN.png 命名（ffmpeg 默认 0001.png / 多段前缀）→ 不再依赖文件名解析
        d = tempfile.mkdtemp(prefix='test_oddnames_')
        try:
            for i in range(12):
                img = Image.new('RGBA', (128, 128), (255, 255, 255, 255))
                ImageDraw.Draw(img).rectangle(
                    [i * 8, 40, i * 8 + 30, 90], fill=(50, 50, 50, 255))
                img.save(os.path.join(d, f'{i:04d}.png'))  # 纯数字命名
            assert len(select_frames(d, 12)) == 12
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_prefixed_names(self):
        # 多段前缀命名（redshao_run_001.png）→ 同样不崩
        d = tempfile.mkdtemp(prefix='test_prefixed_')
        try:
            for i in range(12):
                img = Image.new('RGBA', (128, 128), (255, 255, 255, 255))
                ImageDraw.Draw(img).rectangle(
                    [i * 8, 40, i * 8 + 30, 90], fill=(50, 50, 50, 255))
                img.save(os.path.join(d, f'pet_run_{i:03d}.png'))
            assert len(select_frames(d, 12)) == 12
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_over_100_frames_order(self):
        # A-6: 输出 p_100.png 排序正确（三位序号防字典序错乱）
        d = make_frames(120, size=64)
        out = tempfile.mkdtemp(prefix='test_out100_')
        try:
            picks = select_frames(d, 12)
            for i, f in enumerate(picks):
                shutil.copy(os.path.join(d, f), os.path.join(out, f'p_{i:03d}.png'))
            files = sorted(os.listdir(out))
            assert files[0] == 'p_000.png' and files[-1] == 'p_011.png'
        finally:
            shutil.rmtree(d, ignore_errors=True)
            shutil.rmtree(out, ignore_errors=True)

    def test_fewer_frames_than_target(self):
        # 帧数不足 → 全返回，不崩（WorkBuddy 边界 #1）
        d = make_frames(10)
        try:
            assert len(select_frames(d, 12)) == 10
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_identical_frames_backfill(self):
        # 全相同帧 → 去重后必须补回到 target_n（补帧逻辑）
        d = make_frames(20, move=False)
        try:
            assert len(select_frames(d, 12)) == 12
        finally:
            shutil.rmtree(d, ignore_errors=True)


class TestCleanCutout:
    def _transparent_img(self, rects):
        img = Image.new('RGBA', (200, 200), (0, 0, 0, 0))
        dr = ImageDraw.Draw(img)
        for r in rects:
            dr.rectangle(r, fill=(255, 0, 0, 255))
        return img

    def test_keeps_separated_regions(self):
        # 身体(81×81=6561) + 腿(21×41=861) + 尾巴(21×41=861)：分离连通域全保留（踩坑 #3 铁律）
        # PIL rectangle 坐标含终点，故宽=81/21 而非 80/20
        img = self._transparent_img([
            (10, 10, 90, 90), (20, 150, 40, 190), (150, 20, 170, 60)])
        a = np.asarray(clean(img, min_size=500))[:, :, 3]
        assert (a > 10).sum() == 6561 + 861 + 861

    def test_removes_small_noise(self):
        # 身体(6561) + 噪点(11×21=231 < 500)：噪点被删
        img = self._transparent_img([(10, 10, 90, 90), (150, 150, 160, 170)])
        a = np.asarray(clean(img, min_size=500))[:, :, 3]
        assert (a > 10).sum() == 6561

    def test_fully_transparent_no_crash(self):
        img = Image.new('RGBA', (100, 100), (0, 0, 0, 0))
        out = clean(img)
        assert (np.asarray(out)[:, :, 3] == 0).all()


class TestMakeSheet:
    def test_empty_dir_raises(self):
        d, out = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            with pytest.raises(RuntimeError):
                make_sheet(d, out, cell=128)
        finally:
            shutil.rmtree(d, ignore_errors=True)
            shutil.rmtree(out, ignore_errors=True)

    def test_transparent_frame_warns(self, capsys):
        # 全透明帧 → 警告 + 空白帧占位，不崩
        d, out = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            Image.new('RGBA', (100, 100), (0, 0, 0, 0)).save(
                os.path.join(d, 'f_00.png'))
            img = Image.new('RGBA', (100, 100), (0, 0, 0, 0))
            ImageDraw.Draw(img).rectangle(
                [10, 10, 50, 50], fill=(255, 0, 0, 255))
            img.save(os.path.join(d, 'f_01.png'))
            make_sheet(d, out, cell=128, name='t.png')
            assert '未检测到不透明内容' in capsys.readouterr().out
            sheet = Image.open(os.path.join(out, 't.png'))
            # target 自适应（非固定 cell）：两帧横排 → 宽 = 高 × 2
            assert sheet.size[0] == sheet.size[1] * 2
        finally:
            shutil.rmtree(d, ignore_errors=True)
            shutil.rmtree(out, ignore_errors=True)

    def test_all_transparent_raises_friendly(self):
        # A-4: 全部帧全透明 → 友好 RuntimeError，而不是 max([]) ValueError
        d, out = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            for i in range(3):
                Image.new('RGBA', (100, 100), (0, 0, 0, 0)).save(
                    os.path.join(d, f'f_{i:02d}.png'))
            with pytest.raises(RuntimeError, match='全透明'):
                make_sheet(d, out, cell=128)
        finally:
            shutil.rmtree(d, ignore_errors=True)
            shutil.rmtree(out, ignore_errors=True)

    def test_bbox_off_by_one(self):
        # A-5: bbox 右下 +1（crop 开区间）——内容不再丢 1px
        d, out = tempfile.mkdtemp(), tempfile.mkdtemp()
        try:
            img = Image.new('RGBA', (100, 100), (0, 0, 0, 0))
            ImageDraw.Draw(img).rectangle(
                [10, 10, 59, 59], fill=(255, 0, 0, 255))  # 50×50
            img.save(os.path.join(d, 'f_00.png'))
            make_sheet(d, out, cell=128, name='t.png')
            sheet = Image.open(os.path.join(out, 't.png'))
            # target = 50 + 2*pad(≈6) ≈ 62（内容不丢 1px 边）
            a = np.asarray(sheet)[:, :, 3]
            assert (a > 10).sum() >= 2500  # 至少保住 50×50 主体
        finally:
            shutil.rmtree(d, ignore_errors=True)
            shutil.rmtree(out, ignore_errors=True)

    def test_texture_limit_rejected(self):
        # 17 帧 × 1024 = 17408 > 16384 → SystemExit(1)（WebGL 铁律）
        d = make_frames(17, size=1024)
        out = tempfile.mkdtemp()
        try:
            with pytest.raises(SystemExit) as e:
                make_sheet(d, out, cell=1024)
            assert e.value.code == 1
        finally:
            shutil.rmtree(d, ignore_errors=True)
            shutil.rmtree(out, ignore_errors=True)
