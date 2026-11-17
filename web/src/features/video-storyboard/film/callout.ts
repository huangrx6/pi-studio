import type { StoryboardCallout } from '../../../types/storyboard-types';

export function drawCallout(ctx: OffscreenCanvasRenderingContext2D, box: StoryboardCallout, time: number) {
  if (time < box.startMs || time >= box.endMs) return;
  const { width, height } = ctx.canvas;
  const u = Math.min(width, height) / 720;
  const fadeMs = Math.min(160, (box.endMs - box.startMs) / 3);
  const ramp = Math.min(1, (time - box.startMs) / fadeMs, (box.endMs - time) / fadeMs);
  const opacity = ramp * ramp * (3 - 2 * ramp);
  const x = box.x * width, y = box.y * height, w = box.width * width, h = box.height * height;

  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(10 * u, w / 2, h / 2));
  ctx.fillStyle = 'rgba(101,230,193,.09)';
  ctx.fill();
  ctx.lineWidth = 6 * u;
  ctx.strokeStyle = 'rgba(8,32,29,.72)';
  ctx.stroke();
  ctx.lineWidth = 3 * u;
  ctx.strokeStyle = '#7de5c7';
  ctx.stroke();

  const label = box.label?.trim();
  if (label) {
    ctx.font = `600 ${21 * u}px "PingFang SC","Microsoft YaHei",sans-serif`;
    const pad = 10 * u, gap = 6 * u;
    const labelW = Math.min(ctx.measureText(label).width + 2 * pad, width - gap * 2);
    const labelH = 34 * u;
    const left = Math.max(gap, Math.min(x, width - gap - labelW));
    const top = y >= labelH + 2 * gap ? y - gap - labelH : Math.min(y + gap, height - gap - labelH);
    ctx.fillStyle = '#143f36';
    ctx.beginPath();
    ctx.roundRect(left, top, labelW, labelH, 7 * u);
    ctx.fill();
    ctx.fillStyle = '#eafff7';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, left + pad, top + labelH / 2, labelW - 2 * pad);
  }
  ctx.restore();
}
