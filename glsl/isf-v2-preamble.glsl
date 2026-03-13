// ── ISF v2-only built-ins (shared between fragment and vertex shaders) ────────

/** Time delta since last frame, in seconds. */
uniform float TIMEDELTA;

/** Current frame index (0-based). */
uniform int FRAMEINDEX;

/** Current date/time: x=year, y=month, z=day, w=seconds since midnight. */
uniform vec4 DATE;

/** Get the size of `tex` in pixels as a vec2. */
#define IMG_SIZE(tex) vec2(0.)
