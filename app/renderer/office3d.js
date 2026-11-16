// 3D office (contract v3.79): draws src/office3d.mjs's boxes with WebGL 1 (no library) into an offscreen canvas, which
// office-view.js copies onto the office canvas; labels (the bots' tags, desk plates, the board) are drawn on top with
// the 2D context. Light: one sun from the top left with a shadow map (depth packed into RGBA), a sky/ground fill,
// emissive screens, LEDs and dance-floor tiles.
import { buildStatic, buildDynamic, staticKey, cameraFor, project, pickBot, mul, norm, lookAt, ortho } from '../src/office3d.mjs'

const VS = `attribute vec3 aPos; attribute vec3 aNor; attribute vec3 aCol; attribute float aEmi;
uniform mat4 uMVP; uniform mat4 uLight; varying vec3 vNor; varying vec3 vCol; varying float vEmi; varying vec4 vL; varying vec3 vPos;
void main(){ gl_Position = uMVP * vec4(aPos, 1.0); vL = uLight * vec4(aPos, 1.0); vNor = aNor; vCol = aCol; vEmi = aEmi; vPos = aPos; }`
const FS = `precision highp float; varying vec3 vNor; varying vec3 vCol; varying float vEmi; varying vec4 vL; varying vec3 vPos;
uniform sampler2D uShadow; uniform vec3 uDir; uniform float uTexel; uniform vec3 uCam; uniform float uFar;
float unpack(vec4 c){ return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }
void main(){
  vec3 n = normalize(vNor);
  vec3 p = vL.xyz / vL.w * 0.5 + 0.5;
  float sh = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    float d = unpack(texture2D(uShadow, p.xy + vec2(float(i), float(j)) * uTexel));
    sh += (p.z - 0.004 > d) ? 1.0 : 0.0;
  }
  sh /= 9.0;
  float diff = max(dot(n, -uDir), 0.0) * (1.0 - 0.72 * sh);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 c = vCol * (0.34 + 0.22 * hemi + 0.62 * diff);
  c *= mix(vec3(0.86, 0.9, 1.0), vec3(1.06, 1.0, 0.92), diff);
  c = mix(c, vCol * 1.15, vEmi);
  c *= 1.0 - 0.25 * smoothstep(uFar * 0.55, uFar, distance(vPos, uCam));
  gl_FragColor = vec4(c, 1.0);
}`
const DVS = `attribute vec3 aPos; uniform mat4 uLight; void main(){ gl_Position = uLight * vec4(aPos, 1.0); }`
const DFS = `precision highp float; vec4 pack(float d){ vec4 e = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * d); e -= e.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0); return e; }
void main(){ gl_FragColor = pack(gl_FragCoord.z); }`
const SUN = norm([-0.5, -1, -0.6])
const SM = 2048 // shadow map size

const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}`

/** → a 3D office renderer, or null when WebGL is not available (the office then stays 8-bit). */
export function createOffice3d() {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true })
  if (!gl) return null
  const shader = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(String(gl.getShaderInfoLog(s)))
    return s
  }
  const program = (vs, fs) => {
    const p = gl.createProgram()
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs))
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(String(gl.getProgramInfoLog(p)))
    return p
  }
  let main
  let depth
  try {
    main = program(VS, FS)
    depth = program(DVS, DFS)
  } catch (e) {
    console.error('3D office:', e)
    return null
  }
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SM, SM, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v)
  const fbo = gl.createFramebuffer()
  const rb = gl.createRenderbuffer()
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb)
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, SM, SM)
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  // one set of buffers for the static part (uploaded when its key changes), one for the moving part (every frame)
  const sets = [0, 1].map(() => ({ p: gl.createBuffer(), n: gl.createBuffer(), c: gl.createBuffer(), e: gl.createBuffer(), count: 0 }))
  const upload = (set, mesh, usage) => {
    for (const k of ['p', 'n', 'c', 'e']) {
      gl.bindBuffer(gl.ARRAY_BUFFER, set[k])
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh[k]), usage)
    }
    set.count = mesh.count
  }
  const attr = (prog, name, buf, size) => {
    const l = gl.getAttribLocation(prog, name)
    if (l < 0) return
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.enableVertexAttribArray(l)
    gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0)
  }
  const u = (prog, name) => gl.getUniformLocation(prog, name)

  let key = ''
  let camKey = ''
  let cam = null
  let anchors = new Map()
  let tagBoxes = []

  /** Draws the scene at w × h onto ctx (the office canvas's 2D context), labels included. */
  function draw(ctx, w, h, scene, selected) {
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const k = staticKey(scene)
    if (k !== key) {
      key = k
      upload(sets[0], buildStatic(scene), gl.STATIC_DRAW)
    }
    const dyn = buildDynamic(scene)
    anchors = dyn.anchors
    upload(sets[1], dyn.mesh, gl.DYNAMIC_DRAW)
    const ck = `${scene.LW}x${scene.LH}@${w}x${h}`
    if (ck !== camKey) {
      camKey = ck
      cam = cameraFor(scene.LW, scene.LH, w, h)
    }
    const ctr = [scene.LW / 2, 0, scene.LH / 2]
    const span = Math.max(scene.LW, scene.LH) * 0.75
    const light = mul(ortho(-span, span, -span, span, 1, 1200), lookAt(ctr.map((c, i) => c - SUN[i] * 500), ctr, [0, 0, -1]))

    gl.enable(gl.DEPTH_TEST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, SM, SM)
    gl.clearColor(1, 1, 1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(depth)
    gl.uniformMatrix4fv(u(depth, 'uLight'), false, light)
    for (const s of sets) {
      attr(depth, 'aPos', s.p, 3)
      gl.drawArrays(gl.TRIANGLES, 0, s.count)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    const bg = scene.C.frame
    gl.clearColor(((bg >> 16) & 255) / 255, ((bg >> 8) & 255) / 255, (bg & 255) / 255, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(main)
    gl.uniformMatrix4fv(u(main, 'uMVP'), false, cam.mvp)
    gl.uniformMatrix4fv(u(main, 'uLight'), false, light)
    gl.uniform3fv(u(main, 'uDir'), SUN)
    gl.uniform3fv(u(main, 'uCam'), cam.eye)
    gl.uniform1f(u(main, 'uFar'), Math.hypot(cam.eye[1], cam.eye[2] - scene.LH * 0.5) + scene.LH)
    gl.uniform1f(u(main, 'uTexel'), 1 / SM)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(u(main, 'uShadow'), 0)
    for (const s of sets) {
      attr(main, 'aPos', s.p, 3)
      attr(main, 'aNor', s.n, 3)
      attr(main, 'aCol', s.c, 3)
      attr(main, 'aEmi', s.e, 1)
      gl.drawArrays(gl.TRIANGLES, 0, s.count)
    }
    ctx.drawImage(canvas, 0, 0)
    labels(ctx, w, h, scene, selected)
  }

  // ---- labels: 2D text over the 3D picture, sized to the canvas
  function labels(ctx, w, h, scene, selected) {
    const P = (p) => project(cam.mvp, p, w, h)
    const px = Math.max(9, Math.round(h / 52))
    ctx.save()
    ctx.textBaseline = 'alphabetic'
    // desk plates: the number or the project's short name
    ctx.font = `bold ${Math.round(px * 0.8)}px Menlo, "SF Mono", monospace`
    scene.desks.forEach((d, i) => {
      const p = P([d.cx, 4, d.by + 2.7])
      if (!p) return
      const s = d.proj ? d.proj.short : String(i + 1)
      ctx.fillStyle = d.proj ? hex(scene.C.dark) : hex(scene.C.deskLeg)
      ctx.fillText(s, p[0] - ctx.measureText(s).width / 2, p[1] + px * 0.3)
    })
    // the board: today's deliveries
    const bp = P([69, 7, scene.L.hallFaceTop + 1.2])
    if (bp) {
      ctx.font = `bold ${Math.round(px * 0.75)}px Menlo, "SF Mono", monospace`
      ctx.fillStyle = hex(scene.C.marker)
      ctx.fillText(scene.today.join(' · '), bp[0] - ctx.measureText(scene.today.join(' · ')).width / 2, bp[1] + px * 0.55)
    }
    // tags above the bots
    tagBoxes = []
    ctx.font = `bold ${px}px Menlo, "SF Mono", monospace`
    for (const t of scene.tags) {
      const a = anchors.get(t.id)
      if (!a) continue
      const p = P([a.x, a.top + 3, a.z])
      if (!p) continue
      const lw = Math.max(...t.lines.map(([s]) => ctx.measureText(s).width)) + px
      const lh = t.lines.length * px * 1.15 + px * 0.5
      const x = Math.round(p[0] - lw / 2)
      const y = Math.round(p[1] - lh)
      ctx.fillStyle = hex(t.edge)
      ctx.fillRect(x - 2, y - 2, lw + 4, lh + 4)
      ctx.fillStyle = hex(scene.C.dark)
      ctx.fillRect(x, y, lw, lh)
      t.lines.forEach(([s, c], i) => {
        ctx.fillStyle = hex(c)
        ctx.fillText(s, x + (lw - ctx.measureText(s).width) / 2, y + px * (1.05 + i * 1.15))
      })
      tagBoxes.push({ id: t.id, x: x - 2, y: y - 2, w: lw + 4, h: lh + 4 })
    }
    // the selected bot: an arrow bobbing above it
    const a = selected ? anchors.get(selected) : null
    const ap = a && P([a.x, a.top + (scene.tags.some((t) => t.id === selected) ? 14 : 4), a.z])
    if (ap) {
      const bob = Math.floor(scene.now / 220) % 2 ? 2 : 0
      const s = px * 0.8
      ctx.fillStyle = hex(scene.C.accent)
      ctx.strokeStyle = hex(scene.C.ol)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(ap[0] - s, ap[1] - s * 1.6 - bob)
      ctx.lineTo(ap[0] + s, ap[1] - s * 1.6 - bob)
      ctx.lineTo(ap[0], ap[1] - s * 0.4 - bob)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
  }

  return {
    draw,
    /** The bot (or its tag) under a canvas pixel, or null. */
    pick(px, py, w, h) {
      const tag = tagBoxes.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h)
      if (tag) return tag.id
      return cam ? pickBot(anchors, cam.mvp, w, h, px, py) : null
    },
  }
}
