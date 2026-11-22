import { resolveViewport, scaleTv } from '../resolve-viewport';

describe('scaleTv and TV 1080p logical normalization (#281)', () => {
  it('computes tvScale 0.5 for 960x540dp Android TV and 1.0 for 1920x1080pt tvOS', () => {
    const androidTv = resolveViewport({ isTV: true, os: 'android', width: 960, height: 540 });
    const tvos = resolveViewport({ isTV: true, os: 'ios', width: 1920, height: 1080 });
    const hdTv = resolveViewport({ isTV: true, os: 'android', width: 1280, height: 720 });

    expect(androidTv.tvScale).toBe(0.5);
    expect(tvos.tvScale).toBe(1);
    expect(hdTv.tvScale).toBe(0.667);

    expect(scaleTv(64, androidTv)).toBe(32);
    expect(scaleTv(48, androidTv)).toBe(24);
    expect(scaleTv(15, androidTv)).toBe(8);

    expect(scaleTv(64, tvos)).toBe(64);
    expect(scaleTv(48, tvos)).toBe(48);

    expect(scaleTv(60, hdTv)).toBe(40);
  });

  it('clamps tvScale within [0.5, 1.5] for extreme TV resolutions', () => {
    const tinyTv = resolveViewport({ isTV: true, os: 'android', width: 640, height: 360 });
    const uhdTv = resolveViewport({ isTV: true, os: 'ios', width: 3840, height: 2160 });

    expect(tinyTv.tvScale).toBe(0.5);
    expect(uhdTv.tvScale).toBe(1.5);
    expect(scaleTv(40, tinyTv)).toBe(20);
    expect(scaleTv(40, uhdTv)).toBe(60);
  });

  it('returns identity on phone, tablet, and desktop viewports', () => {
    const phone = resolveViewport({ isTV: false, os: 'ios', width: 393, height: 852 });
    const tablet = resolveViewport({ isTV: false, os: 'android', width: 834, height: 1194 });
    const desktop = resolveViewport({ isTV: false, os: 'web', width: 1920, height: 1080 });

    expect(phone.tvScale).toBe(1);
    expect(tablet.tvScale).toBe(1);
    expect(desktop.tvScale).toBe(1);

    expect(scaleTv(56, phone)).toBe(56);
    expect(scaleTv(56, tablet)).toBe(56);
    expect(scaleTv(56, desktop)).toBe(56);
    // Even if a caller passes a synthetic non-1 tvScale on a non-tv formFactor, scaleTv is identity.
    expect(scaleTv(56, { formFactor: 'desktop', tvScale: 0.5 })).toBe(56);
    expect(scaleTv(56, { formFactor: 'phone', tvScale: 0.5 })).toBe(56);
    expect(scaleTv(56, { formFactor: 'tablet', tvScale: 0.5 })).toBe(56);
  });
});
