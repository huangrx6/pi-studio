import type { Scene } from './timeline';
import { fps } from './timeline';
import { drawCallout } from './callout';

type Picture = ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
const font = '"PingFang SC","Microsoft YaHei",sans-serif';

function lines(ctx: OffscreenCanvasRenderingContext2D, text: string, max: number) {
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const letter of paragraph) {
      if (line && ctx.measureText(line + letter).width > max) { result.push(line); line = ''; }
      line += letter;
    }
    result.push(line);
  }
  return result;
}

export function drawFrame(ctx: OffscreenCanvasRenderingContext2D, scene: Scene, frame: number, picture: Picture | undefined, filmTitle: string) {
  const { width: w, height: h } = ctx.canvas;
  const u = Math.min(w, h) / 720;
  const { shot } = scene;
  const settings = shot.composition;
  const opening = Boolean(settings?.heading && picture);
  const frac = frame / Math.max(1, scene.frames - 1);
  const ease = frac * frac * (3 - 2 * frac);
  const time = frame * 1000 / fps;
  const margin = 48 * u;
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#162a2b'); bg.addColorStop(1, '#101619');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  if (picture) {
    const box = opening ? { x: 0, y: 0, w, h } : { x: margin, y: 92 * u, w: w - margin * 2, h: h - 216 * u };
    const focus = settings?.pointer ?? { x: .5, y: .5 };
    const zoom = settings?.camera === 'push' ? 1 + ease * (settings.pointer ? .85 : .09) : settings?.camera === 'pull' ? 1.12 - .12 * ease : 1;
    const scale = (opening ? Math.max : Math.min)(box.w / picture.width, box.h / picture.height) * zoom;
    const dw = picture.width * scale, dh = picture.height * scale;
    // Near an edge, retain the screenshot's margin around the control as we zoom.
    const anchorX = Math.max(0, Math.min(1, (focus.x - .1) / .8));
    const x = box.x + (box.w - dw) * (dw > box.w ? anchorX : .5);
    const y = box.y + (box.h - dh) * (dh > box.h ? focus.y : .5);
    ctx.save(); ctx.beginPath(); ctx.roundRect(box.x, box.y, box.w, box.h, opening ? 0 : 14 * u); ctx.clip();
    ctx.drawImage(picture, x, y, dw, dh);
    if (settings?.pointer) {
      const { atMs } = settings.pointer;
      const arrival = Math.min(1, Math.max(0, (time - atMs + 1000) / 800));
      const px = x + dw * focus.x + (1 - arrival) * 96 * u;
      const py = y + dh * focus.y - (1 - arrival) * 44 * u;
      if (time >= atMs - 1000) {
        ctx.save(); ctx.translate(px, py); ctx.scale(u, u);
        const pulse = (time - atMs) / 500;
        if (pulse >= 0 && pulse < 1) {
          ctx.strokeStyle = `rgba(99,238,196,${1 - pulse})`; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(0, 0, 10 + pulse * 35, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(3, 24); ctx.lineTo(9, 17); ctx.lineTo(16, 27); ctx.lineTo(20, 24);
        ctx.lineTo(13, 14); ctx.lineTo(22, 12); ctx.closePath(); ctx.fillStyle = 'white'; ctx.fill(); ctx.strokeStyle = '#162224'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }
  if (opening || !picture) {
    if (opening) {
      const shade = ctx.createLinearGradient(0, 0, w, 0);
      shade.addColorStop(0, '#0b1115bc'); shade.addColorStop(.8, '#0b111500'); ctx.fillStyle = shade; ctx.fillRect(0, 0, w, h);
    }
    ctx.fillStyle = '#93daca'; ctx.fillRect(margin, h * .36, 44 * u, 4 * u);
    ctx.font = `600 ${22 * u}px ${font}`; ctx.fillText(filmTitle, margin, h * .36 + 37 * u, w - 2 * margin);
    ctx.font = `650 ${60 * u}px ${font}`; ctx.fillStyle = '#ffffff';
    const titleLines = lines(ctx, settings?.heading || shot.purpose || '文字镜头', w - margin * 2);
    titleLines.slice(0, 3).forEach((line, i) => ctx.fillText(line, margin, h * .36 + (108 + i * 72) * u));
  } else {
    ctx.fillStyle = '#eaf2ef'; ctx.font = `600 ${26 * u}px ${font}`;
    ctx.fillText(shot.purpose, margin, 48 * u, w - margin * 2);
  }
  if (settings?.callout) drawCallout(ctx, settings.callout, time);
  const caption = shot.captions.filter(c => c.startMs <= time && time < c.endMs).map(c => c.text).join('\n').trim();
  if (caption) {
    ctx.font = `500 ${32 * u}px ${font}`;
    const text = lines(ctx, caption, w - margin * 2 - 44 * u);
    const row = 43 * u, pad = 13 * u;
    const cw = Math.max(...text.map(line => ctx.measureText(line).width)) + 42 * u;
    const ch = text.length * row + pad * 2;
    const bottom = h - 30 * u;
    ctx.fillStyle = 'rgba(9,15,18,.92)'; ctx.beginPath(); ctx.roundRect((w - cw) / 2, bottom - ch, cw, ch, 11 * u); ctx.fill();
    ctx.textAlign = 'center'; ctx.fillStyle = '#f4f7f5';
    text.forEach((line, i) => ctx.fillText(line, w / 2, bottom - ch + pad + (i + .5) * row));
    ctx.textAlign = 'left';
  }
}
