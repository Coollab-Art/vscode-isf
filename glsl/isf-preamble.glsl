// ── ISF built-in uniforms ────────────────────────────────────────────────────
// These are automatically injected into every ISF shader (fragment and vertex).

/** Output render size in pixels.*/
uniform vec2 RENDERSIZE;

/** Elapsed time in seconds since the shader started.*/
uniform float TIME;

/** Per-pass index */
uniform int PASSINDEX;

// ── ISF image sampling functions ─────────────────────────────────────────────

/** Sample `tex` at the current fragment's normalized coordinate. */
#define IMG_THIS_PIXEL(tex) texture(tex, vec2(0.))

/** Sample `tex` at the current fragment's normalized coordinate (alias for IMG_THIS_PIXEL). */
#define IMG_THIS_NORM_PIXEL(tex) texture(tex, vec2(0.))

/** Sample `tex` at the current fragment's normalized coordinate (alias for IMG_THIS_PIXEL). */
#define IMG_NORM_THIS_PIXEL(tex) texture(tex, vec2(0.))

/** Sample `tex` at a pixel coordinate `pos` (in pixels, not normalized). */
#define IMG_PIXEL(tex, pos) texture(tex, (pos) / RENDERSIZE)

/** Sample `tex` at a normalized coordinate `normPos` in [0.0, 1.0]. */
#define IMG_NORM_PIXEL(tex, normPos) texture(tex, normPos)
