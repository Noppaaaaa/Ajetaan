import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as net from './net.js';

let playerName = '';
let soloMode = false;      // yksinpeli: ei lähetetä sijaintia, ei näytetä muita
let _soloApplied = false;

// ════════════════════════════════════════════════════════════
//  ÄÄRETÖN TIE — endless procedural driving
// ════════════════════════════════════════════════════════════

// ── Tunables ──
const SEA          = 20;       // sea level (y)
const CHUNK        = 20;       // world units per terrain chunk (2× car length)
const SEG          = 8;        // terrain grid resolution per chunk (finer = less clipping)
let   VIEW_R       = 30;       // chunk view radius (mutable via settings)
let   _chunksPerFrame = 4;    // chunks built per frame (mutable via settings)
let   _colFrame = 0;
let   _canDrive = false;     // true after name prompt submitted
const ROAD_STEP    = 6;       // spacing between road waypoints
const ROAD_HALF    = 5.6;      // road half width (flat part)
const CARVE_R      = 25;       // terrain smoothing radius around road
const RCELL        = 24;       // road spatial-hash cell size
const LOD_R        = 10;       // chunks within this radius get full quality
const FAR_LOD_R    = 20;       // chunks beyond this get bare terrain only (no vegetation)

// Car / physics
const MAX_SPEED    = 100;       // m/s (~302 km/h)
const MAX_REVERSE  = 20;
const ACCEL        = 20;
const BRAKE        = 26;
const TURN_RATE    = 1;
const WHEELBASE    = 2.7;
const TRACK        = 1.7;
const WHEEL_R      = 0.34;
const RIDE_H       = 0.2;
const GRAVITY      = 9.81;
const CAR_MASS     = 2000;
const ENGINE_MAX_TORQUE = 280;
const REDLINE_RPM  = 7000;
const IDLE_RPM     = 900;
const GEAR_RATIOS  = [0, 3.5, 2.1, 1.4, 1.0, 0.75];
const FINAL_DRIVE  = 3.5;
const DRIVETRAIN_EFF = 0.85;
const MAX_STEER_ANGLE = 0.55;
const TIRE_FRICTION_ROAD = 1.0;
const TIRE_FRICTION_OFFROAD = 0.6;
const ROLLING_RESIST = 0.015;
const AIR_DENSITY   = 1.225;
const DRAG_COEF     = 0.35;
const FRONTAL_AREA  = 2.2;
const MAX_BRAKE_TORQUE = 8000;

// ── World regeneration (1-hour epoch + first-player-gets-fresh-world) ──
const WORLD_MS = 3600000;
let worldSeed = Math.floor(Date.now() / WORLD_MS)+1;
let totalDriveM = 0;      // kumulatiivinen ajettu matka (metriä)
let _seenPeer = false;    // onko peer-viestiä koskaan tullut tässä istunnossa

// ── Persistent flatten map & tire tracks ──
const TRACK_HALF = 256;          // world meters from canvas center
const TRACK_SIZE = 1024;         // canvas size (px)
let trackCX = 0, trackCZ = 0;   // canvas center in world coords
const flattenCanvas = document.createElement('canvas');
flattenCanvas.width = flattenCanvas.height = TRACK_SIZE;
const flCtx = flattenCanvas.getContext('2d');
flCtx.fillStyle = '#000'; flCtx.fillRect(0, 0, TRACK_SIZE, TRACK_SIZE);
const flattenTex = new THREE.CanvasTexture(flattenCanvas);
flattenTex.wrapS = flattenTex.wrapT = THREE.ClampToEdgeWrapping;
const trackCanvas = document.createElement('canvas');
trackCanvas.width = trackCanvas.height = TRACK_SIZE;
const trCtx = trackCanvas.getContext('2d');
trCtx.fillStyle = '#fff'; trCtx.fillRect(0, 0, TRACK_SIZE, TRACK_SIZE);
const trackTex = new THREE.CanvasTexture(trackCanvas);
trackTex.wrapS = trackTex.wrapT = THREE.ClampToEdgeWrapping;
const uTrackCenter = { value: new THREE.Vector2(0, 0) };
let _trackUploadTick = 0;
function scrollCanvas(ctx, bg, ocx, ocz, ncx, ncz){
    const dx=Math.round((ocx-ncx)/TRACK_HALF*TRACK_SIZE/2);
    const dz=Math.round((ocz-ncz)/TRACK_HALF*TRACK_SIZE/2);
    if(!dx&&!dz)return;
    const d=ctx.getImageData(0,0,TRACK_SIZE,TRACK_SIZE);
    ctx.fillStyle=bg; ctx.fillRect(0,0,TRACK_SIZE,TRACK_SIZE); ctx.putImageData(d,dx,dz);
}
function recenterTrackMaps(cx,cz){
    scrollCanvas(flCtx,'#000',trackCX,trackCZ,cx,cz);
    scrollCanvas(trCtx,'#fff',trackCX,trackCZ,cx,cz);
    trackCX=cx; trackCZ=cz; uTrackCenter.value.set(cx,cz);
    flattenTex.needsUpdate=true; trackTex.needsUpdate=true;
}
function drawWheelMark(wx,wz,strength){
    const u=((wx-trackCX)/TRACK_HALF+1)*0.5, v=((wz-trackCZ)/TRACK_HALF+1)*0.5;
    const px=Math.round(u*TRACK_SIZE), py=Math.round(v*TRACK_SIZE);
    if(px<-20||px>TRACK_SIZE+20||py<-20||py>TRACK_SIZE+20)return;
    flCtx.fillStyle='#fff'; flCtx.beginPath(); flCtx.arc(px,py,8,0,Math.PI*2); flCtx.fill();
    trCtx.fillStyle='rgba(65,55,40,0.4)'; trCtx.beginPath(); trCtx.arc(px,py,4,0,Math.PI*2); trCtx.fill();
}
let trackOverlay = null;
function initTrackOverlay(){
    const g=new THREE.PlaneGeometry(TRACK_HALF*2,TRACK_HALF*2,1,1);
    g.rotateX(-Math.PI/2);
    const m=new THREE.MeshBasicMaterial({map:trackTex,transparent:true,opacity:0.35,depthWrite:false,blending:THREE.MultiplyBlending,side:THREE.DoubleSide});
    trackOverlay=new THREE.Mesh(g,m); trackOverlay.renderOrder=1; scene.add(trackOverlay);
}
function resetTrackMaps(){
    flCtx.fillStyle='#000'; flCtx.fillRect(0,0,TRACK_SIZE,TRACK_SIZE);
    trCtx.fillStyle='#fff'; trCtx.fillRect(0,0,TRACK_SIZE,TRACK_SIZE);
    flattenTex.needsUpdate=true; trackTex.needsUpdate=true;
}
let worldEpoch = worldSeed;
let worldClockTimer = 0;
const worldClockEl = document.getElementById('clock-time');
// Initialize clock display immediately
(function initClock() {
    const remaining = Math.max(0, (worldEpoch + 1) * WORLD_MS - Date.now());
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    worldClockEl.textContent =
        String(h).padStart(2, '0') + ':' +
        String(m).padStart(2, '0') + ':' +
        String(s).padStart(2, '0');
})();

// ── Small math ──
const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const smoothstep = (a,b,x)=>{ const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
const mix = (a,b,t)=>a+(b-a)*t;
const mixC = (a,b,t)=>[mix(a[0],b[0],t),mix(a[1],b[1],t),mix(a[2],b[2],t)];

// ── Value noise + fbm + domain warp ──
function hash2(x,y){ let n=Math.sin((x+worldSeed*1000)*127.1+(y+worldSeed*1000)*311.7)*43758.5453; return n-Math.floor(n); }
function vnoise(x,z){
    const ix=Math.floor(x), iz=Math.floor(z), fx=x-ix, fz=z-iz;
    const ux=fx*fx*(3-2*fx), uz=fz*fz*(3-2*fz);
    const a=hash2(ix,iz), b=hash2(ix+1,iz), c=hash2(ix,iz+1), d=hash2(ix+1,iz+1);
    return a+(b-a)*ux+(c-a)*uz+(a-b-c+d)*ux*uz; // 0..1
}
function fbm(x,z,oct){
    let v=0,a=0.5,f=1,m=0;
    for(let i=0;i<oct;i++){ v+=a*vnoise(x*f,z*f); m+=a; a*=0.5; f*=2; }
    return v/m; // 0..1
}
function ridged(x,z,oct){
    let v=0,a=0.5,f=1,m=0;
    for(let i=0;i<oct;i++){ const n=1-Math.abs(vnoise(x*f,z*f)*2-1); v+=a*n*n; m+=a; a*=0.5; f*=2; }
    return v/m; // 0..1 sharp ridges
}

// ── Natural terrain height (no road) ──
function naturalHeight(x,z){
    // domain warp for organic shapes
    const wx = x + (fbm(x*0.0011+9.2, z*0.0011+3.7, 3)-0.5)*90;
    const wz = z + (fbm(x*0.0011-4.1, z*0.0011+6.3, 3)-0.5)*90;

    // continents / oceans — biased upward so land dominates and water is scarcer
    const cont = (fbm(wx*0.00034, wz*0.00034, 5)-0.5);
    let h = cont*115 + 30;                         // mostly land; water only in deeper dips

    // mountain mask & ridges
    const mMask = smoothstep(0.52, 0.78, fbm(wx*0.0006+40, wz*0.0006+15, 4));
    const ridge = ridged(wx*0.0017, wz*0.0017, 5);
    h += ridge * mMask * 240;

    // rolling hills
    h += (fbm(wx*0.004, wz*0.004, 4)-0.5) * 18 * (0.4+0.6*mMask);
    // fine detail
    h += (fbm(wx*0.02, wz*0.02, 3)-0.5) * 2.2;

    // gentle valley plains near mid-elevations
    return h;
}
function moistureAt(x,z){ return fbm(x*0.0009+70, z*0.0009+30, 3); }        // 0..1
function forestAt(x,z){ return fbm(x*0.0022-25, z*0.0022+50, 4); }          // 0..1

// ════════════════════════════════════════════════════════════
//  ROAD — infinite deterministic winding path + terrain carve
// ════════════════════════════════════════════════════════════
const roadWP = [];              // {x,z,y,a}
const roadHash = new Map();     // "cx,cz" -> [indices]
let   rGenX=0, rGenZ=0, rGenA=0, rGenH=0, rGenI=0;
let   _roadBias=0;               // directional persistence bias

function roadInsertHash(i){
    const w=roadWP[i];
    const k=Math.floor(w.x/RCELL)+','+Math.floor(w.z/RCELL);
    let a=roadHash.get(k); if(!a){ a=[]; roadHash.set(k,a); }
    a.push(i);
}
function roadPush(){
    // smooth meander from low-frequency noise on the index
    const raw = (fbm(rGenI*0.028+5, 0.5, 4)-0.5) * 0.6;
    const curve = raw + _roadBias * 0.2;
    _roadBias = raw > 0.01 ? 0.3 : (raw < -0.01 ? -0.3 : _roadBias);
    rGenA += curve;
    rGenA = clamp(rGenA, -Math.PI/4, Math.PI/4);
    rGenX += Math.sin(rGenA)*ROAD_STEP;
    rGenZ += Math.cos(rGenA)*ROAD_STEP;
    const nat = naturalHeight(rGenX, rGenZ);
    const target = Math.max(SEA+1.1, nat);         // keep road just above water
    if(rGenI===0) rGenH = target;
    rGenH += (target - rGenH) * 0.25;              // terrain follow
    roadWP.push({ x:rGenX, z:rGenZ, y:rGenH, a:rGenA });
    roadInsertHash(roadWP.length-1);
    rGenI++;
}
function roadInit(){ rGenH = Math.max(SEA+1.1, naturalHeight(0,0)); for(let i=0;i<80;i++) roadPush(); }
function roadExtend(px,pz){
    let guard=0;
    while(guard++ < 4000){
        const last=roadWP[roadWP.length-1];
        const d=Math.hypot(last.x-px, last.z-pz);
        if(d > CHUNK*(VIEW_R+15)+ROAD_STEP*3) break;
        roadPush();
    }
}
// perpendicular distance to road centreline + interpolated road height
function roadInfo(x,z){
    const cx=Math.floor(x/RCELL), cz=Math.floor(z/RCELL);
    let bd=1e18, bi=-1;
    for(let dx=-1;dx<=1;dx++) for(let dz=-1;dz<=1;dz++){
        const a=roadHash.get((cx+dx)+','+(cz+dz)); if(!a) continue;
        for(const i of a){ const w=roadWP[i]; const d=(w.x-x)**2+(w.z-z)**2; if(d<bd){ bd=d; bi=i; } }
    }
    if(bi<0) return { d:1e9, y:0, i:-1 };
    // refine against the two adjacent segments
    let best={ d:Math.sqrt(bd), y:roadWP[bi].y, i:bi };
    for(const j of [bi-1, bi]){
        const p=roadWP[j], q=roadWP[j+1]; if(!p||!q) continue;
        const ex=q.x-p.x, ez=q.z-p.z; const len2=ex*ex+ez*ez||1;
        let t=((x-p.x)*ex+(z-p.z)*ez)/len2; t=clamp(t,0,1);
        const projx=p.x+ex*t, projz=p.z+ez*t;
        const d=Math.hypot(x-projx, z-projz);
        if(d<best.d) best={ d, y:mix(p.y,q.y,t), i:bi };
    }
    return best;
}
// final terrain height (with road corridor blended in)
function getHeight(x,z){
    const nat=naturalHeight(x,z);
    const r=roadInfo(x,z);
    if(r.d<CARVE_R){
        const t = r.d<=ROAD_HALF ? 1 : 1-smoothstep(ROAD_HALF, CARVE_R, r.d);
        return mix(nat, r.y, t);
    }
    return nat;
}
roadInit();   // build the initial road so physics init can read roadWP[0]

// ════════════════════════════════════════════════════════════
//  RENDERER / SCENE / CAMERA
// ════════════════════════════════════════════════════════════
const scene = new THREE.Scene();
const HORIZON = 0xbcd3e0;
scene.background = new THREE.Color(HORIZON);
scene.fog = new THREE.FogExp2(HORIZON, 0.0022);

const camera = new THREE.PerspectiveCamera(62, innerWidth/innerHeight, 0.3, 4000);
const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(HORIZON);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

// ── Lighting ──
const sunDir = new THREE.Vector3(0.55, 0.68, 0.48).normalize();
const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x55613f, 0.75); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.near=1; sun.shadow.camera.far=260;
sun.shadow.camera.left=-90; sun.shadow.camera.right=90;
sun.shadow.camera.top=90; sun.shadow.camera.bottom=-90;
sun.shadow.bias=-0.0006; sun.shadow.normalBias=0.03;
scene.add(sun); scene.add(sun.target);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.35);
fillLight.position.copy(sunDir).multiplyScalar(-1); scene.add(fillLight);

// ════════════════════════════════════════════════════════════
//  SKY
// ════════════════════════════════════════════════════════════
(function buildSky(){
    const uniforms = {
        top:{value:new THREE.Color(0x2b6bb0)},
        mid:{value:new THREE.Color(0x9cc6e6)},
        bot:{value:new THREE.Color(0xdfeaf0)},
        sunDir:{value:sunDir}
    };
    const mat = new THREE.ShaderMaterial({
        side:THREE.BackSide, depthWrite:false, uniforms,
        vertexShader:`varying vec3 vP; void main(){ vP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader:`
        uniform vec3 top,mid,bot,sunDir; varying vec3 vP;
        void main(){
            float h=clamp(vP.y*0.5+0.5,0.0,1.0);
            vec3 c = h<0.5 ? mix(bot,mid,h*2.0) : mix(mid,top,(h-0.5)*2.0);
            float s=pow(max(dot(normalize(vP),sunDir),0.0),120.0);
            float glow=pow(max(dot(normalize(vP),sunDir),0.0),8.0)*0.35;
            c += vec3(1.0,0.92,0.75)*(s*1.2+glow);
            gl_FragColor=vec4(c,1.0);
        }`
    });
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(2600,32,20), mat));
    // visible sun
    const sunMesh=new THREE.Mesh(
        new THREE.SphereGeometry(18,16,16),
        new THREE.MeshBasicMaterial({color:0xfff5e0})
    );
    sunMesh.position.copy(sunDir).multiplyScalar(2500);
    scene.add(sunMesh);
})();

// ── 3D clouds: lit puffball clusters that drift and follow the player ──
// all puffs share one geometry+material, so they render as a single
// InstancedMesh (1 draw call) instead of ~470 separate transparent meshes
const cloudMat = new THREE.MeshStandardMaterial({ color:0xffffff, roughness:1, metalness:0, transparent:true, opacity:0.92, emissive:0x8899aa, emissiveIntensity:0.12 });
const puffGeo = new THREE.IcosahedronGeometry(1, 1);
const clouds = [];      // {x,y,z,drift}
const cloudPuffs = [];  // {ci, ox,oy,oz, sx,sy,sz}
for(let i=0;i<78;i++){
    const puffs=4+Math.floor(Math.random()*5);
    for(let j=0;j<puffs;j++){
        const r=22+Math.random()*30;
        cloudPuffs.push({ ci:i,
            ox:(Math.random()-0.5)*90, oy:(Math.random()-0.5)*14, oz:(Math.random()-0.5)*45,
            sx:r, sy:r*(0.55+Math.random()*0.2), sz:r*(0.8+Math.random()*0.3) });
    }
    const a=Math.random()*6.28, rad=250+Math.random()*750;
    clouds.push({ x:Math.cos(a)*rad, y:240+Math.random()*220, z:Math.sin(a)*rad, drift:4+Math.random()*6 });
}
const cloudMesh = new THREE.InstancedMesh(puffGeo, cloudMat, cloudPuffs.length);
cloudMesh.frustumCulled = false;   // the cloudscape always surrounds the camera
scene.add(cloudMesh);
const _cloudM = new THREE.Matrix4();
function updateClouds(dt){
    // keep the cloudscape centred on the camera so it feels endless
    const bx = camera.position.x, bz = camera.position.z;
    for(const c of clouds){
        c.x += c.drift * dt;
        if(c.x > 1050) c.x -= 2100;   // wrap around
    }
    for(let i=0;i<cloudPuffs.length;i++){
        const p=cloudPuffs[i], c=clouds[p.ci];
        const e=_cloudM.elements;
        e[0]=p.sx; e[1]=0; e[2]=0; e[3]=0;
        e[4]=0; e[5]=p.sy; e[6]=0; e[7]=0;
        e[8]=0; e[9]=0; e[10]=p.sz; e[11]=0;
        e[12]=bx+c.x+p.ox; e[13]=c.y+p.oy; e[14]=bz+c.z+p.oz; e[15]=1;
        cloudMesh.setMatrixAt(i,_cloudM);
    }
    cloudMesh.instanceMatrix.needsUpdate = true;
}

// ── birds ──
const birdGroup = new THREE.Group();
const birdWingMat = new THREE.MeshStandardMaterial({ color:0x2a2a2a, roughness:0.8, side:THREE.DoubleSide });
const birdWingGeo = new THREE.BoxGeometry(0.5, 0.002, 0.12);
const birds = [];
function buildBird(){
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.22), new THREE.MeshStandardMaterial({ color:0x1a1a1a }));
    g.add(body);
    const lw = new THREE.Mesh(birdWingGeo, birdWingMat);
    lw.position.set(-0.25, 0.01, -0.05); lw.rotation.z = 0.2;
    g.add(lw);
    const rw = new THREE.Mesh(birdWingGeo.clone(), birdWingMat);
    rw.position.set(0.25, 0.01, -0.05); rw.rotation.z = -0.2;
    g.add(rw);
    g.userData.wings = [lw, rw];
    return g;
}
for(let i=0;i<30;i++){
    const b = buildBird();
    const a = Math.random()*6.28, rad = 40+Math.random()*80;
    b.position.set(Math.cos(a)*rad, 12+Math.random()*20, Math.sin(a)*rad);
    b.userData.speed = 3+Math.random()*4;
    b.userData.phase = Math.random()*6.28;
    b.userData.radius = rad;
    b.userData.angle = a;
    birds.push(b); birdGroup.add(b);
}
scene.add(birdGroup);
function updateBirds(dt){
    birdGroup.position.x = camera.position.x;
    birdGroup.position.z = camera.position.z;
    const t = performance.now()*0.001;
    for(const b of birds){
        b.userData.angle += b.userData.speed*dt*0.002;
        const rad = b.userData.radius;
        b.position.x = Math.cos(b.userData.angle)*rad;
        b.position.z = Math.sin(b.userData.angle)*rad;
        b.rotation.y = -b.userData.angle + Math.PI/2;
        const flap = Math.sin(t*b.userData.speed + b.userData.phase);
        const wa = b.userData.wings;
        wa[0].rotation.x = flap*0.6;
        wa[1].rotation.x = -flap*0.6;
    }
}

// ════════════════════════════════════════════════════════════
//  WATER — single wave-shaded plane that follows the camera
// ════════════════════════════════════════════════════════════
const waterUniforms = {
    time:{value:0}, sunDir:{value:sunDir},
    deep:{value:new THREE.Color(0x18384f)}, shallow:{value:new THREE.Color(0x3d7d95)}
};
const waterMat = new THREE.ShaderMaterial({
    transparent:true, uniforms:waterUniforms,
    vertexShader:`
    uniform float time; varying vec3 vW; varying vec3 vN;
    void main(){
        vec3 p=position;
        vec4 wp=modelMatrix*vec4(p,1.0);
        float w = sin(wp.x*0.06+time*0.9)*0.16 + sin(wp.z*0.09+time*1.3)*0.12 + sin((wp.x+wp.z)*0.13+time*1.7)*0.06;
        wp.y += w; vW=wp.xyz;
        float dx = cos(wp.x*0.06+time*0.9)*0.06*0.16 + cos((wp.x+wp.z)*0.13+time*1.7)*0.13*0.06;
        float dz = cos(wp.z*0.09+time*1.3)*0.09*0.12 + cos((wp.x+wp.z)*0.13+time*1.7)*0.13*0.06;
        vN = normalize(vec3(-dx,1.0,-dz));
        gl_Position=projectionMatrix*viewMatrix*wp;
    }`,
    fragmentShader:`
    uniform vec3 sunDir,deep,shallow; uniform float time; varying vec3 vW; varying vec3 vN;
    void main(){
        // fine moving ripples perturb the normal per-pixel (cheap ALU only)
        float r1 = sin(vW.x*1.3 + time*2.1) * sin(vW.z*1.1 - time*1.7);
        float r2 = sin((vW.x+vW.z)*2.6 + time*3.2);
        vec3 N = normalize(vec3(vN.x + r1*0.055 + r2*0.028, vN.y, vN.z + r1*0.04 - r2*0.028));
        vec3 V=normalize(cameraPosition-vW);
        float fres=pow(1.0-max(dot(V,N),0.0),3.0);
        vec3 col=mix(deep,shallow,fres*0.55+0.1);
        // grazing angles reflect the sky instead of just brightening the water
        col = mix(col, vec3(0.72,0.81,0.87), fres*0.5);
        vec3 R=reflect(-sunDir,N);
        float d=max(dot(R,V),0.0);
        float spec=pow(d,120.0);
        float glit=pow(d,900.0);          // narrow sun glitter that twinkles with the ripples
        col += vec3(1.0,0.95,0.85)*(spec*0.9 + glit*1.6);
        col += shallow*0.12;
        // blend into scene fog so the horizon doesn't show a hard water edge
        float fd=length(cameraPosition-vW);
        float fogF=1.0-exp(-0.0022*0.0022*fd*fd);
        col=mix(col, vec3(0.737,0.827,0.878), fogF);
        gl_FragColor=vec4(col, 0.86 + fres*0.08);
    }`
});
const waterGeo = new THREE.PlaneGeometry(3400,3400,80,80); waterGeo.rotateX(-Math.PI/2);
let water = null;
function ensureWater(){
    if(water) return;
    water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = SEA; water.renderOrder = 1;
    scene.add(water);
}

// ════════════════════════════════════════════════════════════
//  VEGETATION / ROCK prototypes (merged, vertex-coloured, instanced)
// ════════════════════════════════════════════════════════════
// Simple, robust tree/rock geometries (trunk + one canopy, no geometry merging)
const trunkGeo   = new THREE.CylinderGeometry(0.16,0.32,2.6,6).translate(0,1.3,0);
// layered spruce: three stacked cones merged into ONE geometry (still 1 draw call)
const pineCanGeo = mergeGeometries([
    new THREE.ConeGeometry(1.7,2.8,7).translate(0,2.8,0),
    new THREE.ConeGeometry(1.25,2.3,7).translate(0,4.2,0),
    new THREE.ConeGeometry(0.8,1.9,7).translate(0,5.5,0)
]);
// irregular deciduous crown: main blob + two offset side blobs, merged
const leafCanGeo = mergeGeometries([
    new THREE.IcosahedronGeometry(1.9,1).scale(1,0.85,1).translate(0,3.5,0),
    new THREE.IcosahedronGeometry(1.15,1).scale(1,0.85,1).translate(0.95,4.35,0.3),
    new THREE.IcosahedronGeometry(0.95,1).scale(1,0.8,1).translate(-0.85,4.25,-0.45)
]);
const rockGeo    = new THREE.DodecahedronGeometry(2,0).scale(1,0.7,1.1);
const trunkMat = new THREE.MeshStandardMaterial({ color:0x4a3524, roughness:0.9, metalness:0 });
const pineMat  = new THREE.MeshStandardMaterial({ color:0x2f5d33, roughness:0.85, metalness:0, flatShading:true });
const leafMat  = new THREE.MeshStandardMaterial({ color:0x4a7c35, roughness:0.85, metalness:0, flatShading:true });
const bigLeafGeo = leafCanGeo.clone().scale(1.5,1.5,1.5);  // 1.5x leaf tree
const bigLeafMat = new THREE.MeshStandardMaterial({ color:0x3d6e2e, roughness:0.85, metalness:0, flatShading:true });
const rockMat  = new THREE.MeshStandardMaterial({ color:0x6b6b66, roughness:0.95, metalness:0, flatShading:true });
// lumpy bush: two overlapping blobs merged
const bushGeo  = mergeGeometries([
    new THREE.IcosahedronGeometry(1.2,1).scale(1,0.55,0.85),
    new THREE.IcosahedronGeometry(0.8,1).scale(1,0.5,0.9).translate(0.7,0.12,0.35)
]);
const bushMat  = new THREE.MeshStandardMaterial({ color:0x3a7a2a, roughness:0.9, metalness:0, flatShading:true });
const _tintC = new THREE.Color();   // scratch for per-instance tints

// LOD versions (fewer polygons, no trunk/grass/bushes)
const lodPineGeo = mergeGeometries([
    new THREE.ConeGeometry(1.7,2.9,5).translate(0,2.9,0),
    new THREE.ConeGeometry(1.0,2.8,5).translate(0,4.9,0)
]);
const lodLeafGeo = new THREE.IcosahedronGeometry(1.9,0).scale(1,0.9,1).translate(0,3.6,0);
const lodRockGeo = new THREE.BoxGeometry(1.4,1.0,1.6);

// ── Audio (Web Audio API, procedural) ──
let audioCtx = null;
let engineMain, engineHarm, engineSub, engineGain, engineFilter;
let exhaustGain, exhaustFilter;
let windGain, windFilter, roadGain, roadFilter, skidGain;
let waterNoiseSrc, waterGain, waterFilter, waterLFO;
let _collisionCD = 0;

function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // master bus: gentle compressor glues the layers and stops clipping
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(audioCtx.destination);
    const master = comp;

    // engine: saw + detuned square + half-frequency sub for body
    engineMain = audioCtx.createOscillator();
    engineMain.type = 'sawtooth';
    engineHarm = audioCtx.createOscillator();
    engineHarm.type = 'square';
    engineSub = audioCtx.createOscillator();
    engineSub.type = 'sawtooth';
    engineFilter = audioCtx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 300;
    engineGain = audioCtx.createGain();
    engineGain.gain.value = 0;
    engineMain.connect(engineFilter);
    engineHarm.connect(engineFilter);
    engineSub.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(master);
    engineMain.frequency.value = 50;
    engineHarm.frequency.value = 100;
    engineSub.frequency.value = 25;
    engineMain.start();
    engineHarm.start();
    engineSub.start();

    // one shared looping noise buffer feeds every noise layer
    const bufLen = Math.floor(audioCtx.sampleRate * 1.0);
    const noiseBuf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;
    const noiseSrc = (filter) => {
        const s = audioCtx.createBufferSource();
        s.buffer = noiseBuf; s.loop = true;
        s.connect(filter); s.start();
        return s;
    };

    // exhaust rumble: bandpassed noise that follows rpm under throttle
    exhaustFilter = audioCtx.createBiquadFilter();
    exhaustFilter.type = 'bandpass'; exhaustFilter.frequency.value = 120; exhaustFilter.Q.value = 1.2;
    exhaustGain = audioCtx.createGain(); exhaustGain.gain.value = 0;
    noiseSrc(exhaustFilter); exhaustFilter.connect(exhaustGain); exhaustGain.connect(master);

    // wind hiss: grows with speed squared
    windFilter = audioCtx.createBiquadFilter();
    windFilter.type = 'bandpass'; windFilter.frequency.value = 400; windFilter.Q.value = 0.4;
    windGain = audioCtx.createGain(); windGain.gain.value = 0;
    noiseSrc(windFilter); windFilter.connect(windGain); windGain.connect(master);

    // tire-on-surface noise: dark rumble offroad, lighter hum on asphalt
    roadFilter = audioCtx.createBiquadFilter();
    roadFilter.type = 'lowpass'; roadFilter.frequency.value = 500;
    roadGain = audioCtx.createGain(); roadGain.gain.value = 0;
    noiseSrc(roadFilter); roadFilter.connect(roadGain); roadGain.connect(master);

    // tire screech when sliding on the road
    const skidFilter = audioCtx.createBiquadFilter();
    skidFilter.type = 'bandpass'; skidFilter.frequency.value = 1100; skidFilter.Q.value = 5;
    skidGain = audioCtx.createGain(); skidGain.gain.value = 0;
    noiseSrc(skidFilter); skidFilter.connect(skidGain); skidGain.connect(master);

    // water splash layer (unchanged behaviour)
    waterFilter = audioCtx.createBiquadFilter();
    waterFilter.type = 'lowpass';
    waterFilter.frequency.value = 600;
    waterGain = audioCtx.createGain();
    waterGain.gain.value = 0;
    waterLFO = audioCtx.createOscillator();
    waterLFO.type = 'sine';
    waterLFO.frequency.value = 4;
    const lfoG = audioCtx.createGain();
    lfoG.gain.value = 250;
    waterLFO.connect(lfoG);
    lfoG.connect(waterFilter.frequency);
    waterNoiseSrc = noiseSrc(waterFilter);
    waterFilter.connect(waterGain);
    waterGain.connect(master);
    waterLFO.start();
}

function updateAudio(rpm, throttle, speed, onRoad, slide, hb) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const r = rpm / REDLINE_RPM;
    const freq = 40 + r * 130;
    engineMain.frequency.linearRampToValueAtTime(freq, t + 0.08);
    engineHarm.frequency.linearRampToValueAtTime(freq * 2.02, t + 0.08);
    engineSub.frequency.linearRampToValueAtTime(freq * 0.5, t + 0.08);
    engineFilter.frequency.linearRampToValueAtTime(200 + r * 900, t + 0.08);
    const vol = Math.max(0.005, throttle * 0.16 + r * 0.05);
    engineGain.gain.linearRampToValueAtTime(vol, t + 0.08);
    // exhaust follows rpm, loudest under load
    exhaustFilter.frequency.linearRampToValueAtTime(90 + r * 420, t + 0.08);
    exhaustGain.gain.linearRampToValueAtTime(throttle * 0.055 + r * 0.02, t + 0.08);
    // wind
    const sp = speed / MAX_SPEED;
    windFilter.frequency.linearRampToValueAtTime(300 + sp * 900, t + 0.1);
    windGain.gain.linearRampToValueAtTime(sp * sp * 0.16, t + 0.1);
    // tires: darker and louder on gravel/grass
    roadFilter.frequency.linearRampToValueAtTime(onRoad ? 650 : 220, t + 0.1);
    const rollV = speed > 0.5 ? Math.min(0.055, speed * 0.0011) * (onRoad ? 1 : 2.4) : 0;
    roadGain.gain.linearRampToValueAtTime(rollV, t + 0.1);
    // skid screech only on asphalt
    const skidV = (onRoad && speed > 5 && (slide > 3 || hb)) ? clamp((Math.max(slide, hb ? 4 : 0) - 3) / 6, 0, 1) * 0.11 : 0;
    skidGain.gain.linearRampToValueAtTime(skidV, t + 0.06);
    const wv = waterTime > 0 ? Math.min(0.1, waterTime * 0.03) : 0;
    waterGain.gain.linearRampToValueAtTime(wv, t + 0.1);
}

function playCollision() {
    if (!audioCtx || audioCtx.currentTime < _collisionCD) return;
    _collisionCD = audioCtx.currentTime + 0.12;
    const len = Math.floor(audioCtx.sampleRate * 0.2);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = 700;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.3, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
    src.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
    src.start(); src.stop(audioCtx.currentTime + 0.2);
}

function resumeAudio() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    document.removeEventListener('pointerdown', resumeAudio);
    document.removeEventListener('keydown', resumeAudio);
}
document.addEventListener('pointerdown', resumeAudio);
document.addEventListener('keydown', resumeAudio);

// blade geometry for grass: tapered, gently bent blade (3 tris instead of 1)
const bladeGeo = (()=>{
    const g=new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -0.06,0,0,      0.06,0,0,
        -0.035,0.17,0.035,  0.035,0.17,0.035,
         0,0.34,0.1
    ]),3));
    g.setIndex([0,1,2, 1,3,2, 2,3,4]); g.computeVertexNormals(); return g;
})();
const grassMat = new THREE.MeshStandardMaterial({ color:0x6a9a4a, roughness:1, metalness:0, side:THREE.DoubleSide });
// wind sway: displace blade tips based on world position + time
const grassWind = { value:0 };
const grassCarPos = { value:new THREE.Vector3(0,0,0) };
let windTime = 0;
grassMat.onBeforeCompile = (sh)=>{
    sh.uniforms.uWind = grassWind;
    sh.uniforms.uCarPos = grassCarPos;
    sh.vertexShader = 'uniform float uWind;\nuniform vec3 uCarPos;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float bH = position.y;
         vec4 wp4 = instanceMatrix * vec4(position, 1.0);
         float ph = wp4.x*0.22 + wp4.z*0.22;
         float gust = 0.6 + 0.4*sin(uWind*0.4 + wp4.x*0.02);
         transformed.x += sin(uWind*1.7 + ph) * 0.44 * bH * gust;
         transformed.z += cos(uWind*1.3 + ph*0.8) * 0.28 * bH * gust;
         vec3 toCar = wp4.xyz - uCarPos;
         float carDist = length(toCar.xz);
         float flatten = 1.0 - smoothstep(0.5, 2.8, carDist);
         vec2 carDir = carDist < 0.001 ? vec2(0.0) : toCar.xz / carDist;
         transformed.y -= bH * flatten * 0.7;
         transformed.x += carDir.x * flatten * bH * 0.2;
         transformed.z += carDir.y * flatten * bH * 0.2;`
    );
};

// deterministic per-chunk PRNG
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

// ── terrain colouring ──
const C_UNDER=[0.14,0.18,0.17], C_SAND=[0.74,0.69,0.5], C_ROCK=[0.34,0.33,0.31], C_SNOW=[0.92,0.94,0.97];
function terrainColor(y,slope,moist){
    let base;
    if(y<SEA-0.3) base=C_UNDER;
    else if(y<SEA+1.5) base=mixC(C_SAND,[0.66,0.62,0.42], smoothstep(SEA-0.3,SEA+1.5,y));
    else{
        const grass=[0.24+moist*0.12, 0.40+moist*0.16, 0.18+moist*0.04];
        const dry=[0.52,0.5,0.28];
        base=mixC(dry,grass,moist);
        base=mixC(base, C_ROCK, smoothstep(80,140,y));
    }
    base=mixC(base, C_ROCK, smoothstep(0.42,0.72,slope));
    base=mixC(base, C_SNOW, smoothstep(125,170,y)*(1-smoothstep(0.55,0.8,slope)));
    const sh=1-slope*0.15;
    return [clamp(base[0]*sh,0.02,1),clamp(base[1]*sh,0.02,1),clamp(base[2]*sh,0.02,1)];
}

// ════════════════════════════════════════════════════════════
//  CHUNK MANAGER (terrain + trees + rocks + grass, all disposed together)
// ════════════════════════════════════════════════════════════
const terrainMat = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.96, metalness:0 });
const chunks = new Map();          // key -> record
const collideByChunk = new Map();  // key -> [{x,z,r}]

function buildChunk(cx,cz,lod){
    const ox=cx*CHUNK, oz=cz*CHUNK;
    const rec={ objs:[], lod };

    // ── terrain mesh ──
    const seg=lod===0?SEG:(lod===1?Math.ceil(SEG/2):Math.ceil(SEG/3));
    const geo=new THREE.PlaneGeometry(CHUNK,CHUNK,seg,seg); geo.rotateX(-Math.PI/2);
    const pos=geo.attributes.position.array;
    for(let i=0;i<pos.length;i+=3) pos[i+1]=getHeight(ox+pos[i], oz+pos[i+2]);
    geo.computeVertexNormals();
    const nrm=geo.attributes.normal.array;
    const col=new Float32Array(pos.length);
    for(let i=0;i<pos.length;i+=3){
        const y=pos[i+1], slope=1-Math.max(0,nrm[i+1]);
        const m=moistureAt(ox+pos[i], oz+pos[i+2]);
        const c=terrainColor(y,slope,m);
        col[i]=c[0]; col[i+1]=c[1]; col[i+2]=c[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col,3));
    const mesh=new THREE.Mesh(geo, terrainMat);
    mesh.position.set(ox,0,oz); mesh.receiveShadow=lod<2;
    scene.add(mesh); rec.objs.push(mesh);

    if(lod<2){
        // ── scatter vegetation / rocks (half density for LOD) ──
        const density = lod ? 0.5 : 1;
    const rng=mulberry32((cx*73856093)^(cz*19349663));
    const pineM=[], leafM=[], bigLeafM=[], rockM=[], bushM=[], collide=[];
    const dummy=new THREE.Object3D();
    const grassPts=[], grassSmallPts=[];

    const CAND=1;
    for(let i=0;i<CAND;i++){
        const gx=ox+(rng()-0.5)*CHUNK*0.96;
        const gz=oz+(rng()-0.5)*CHUNK*0.96;
        const nat=naturalHeight(gx,gz);
        if(nat<SEA+1.2 || nat>150) continue;
        const r=roadInfo(gx,gz); if(r.d<CARVE_R/2+2) continue;
        const e=2, hL=naturalHeight(gx-e,gz), hR=naturalHeight(gx+e,gz), hD=naturalHeight(gx,gz-e), hU=naturalHeight(gx,gz+e);
        const slope=(Math.abs(hR-hL)+Math.abs(hU-hD))/(2*e);
        if(slope>0.9) continue;
        const forest=forestAt(gx,gz);
        const moist=moistureAt(gx,gz);
        const y=nat;
        if(slope<0.4 && rng()<0.14){
            dummy.position.set(gx,y-0.15,gz);
            const s=0.4+rng()*1.6; dummy.scale.set(s,s*(0.7+rng()*0.5),s);
            dummy.rotation.set(rng()*0.4,rng()*6.28,rng()*0.4);
            dummy.updateMatrix(); rockM.push(dummy.matrix.clone());
            collide.push({x:gx,z:gz,r:s*2.0});
            continue;
        }
        if(forest<0.42 && rng()>forest+0.15) continue;
        const isPine = moist<0.5 || y>70 ? rng()<0.75 : rng()<0.3;
        const s=0.7+rng()*0.8;
        dummy.position.set(gx,y,gz);
        dummy.scale.set(s,s*(0.85+rng()*0.35),s);
        dummy.rotation.set(0,rng()*6.28,0);
        dummy.updateMatrix();
        if(isPine){ pineM.push(dummy.matrix.clone()); collide.push({x:gx,z:gz,r:1.5*s}); }
        else if(rng()<1/6){ bigLeafM.push(dummy.matrix.clone()); collide.push({x:gx,z:gz,r:2.85*s}); }
        else { leafM.push(dummy.matrix.clone()); collide.push({x:gx,z:gz,r:1.9*s}); }
    }
    // ── bushes ──
    {
        const brng=mulberry32((cx*739)^(cz*4963)^3);
        for(let i=0;i<Math.ceil(2.5*density);i++){
            const gx=ox+(brng()-0.5)*CHUNK*0.94, gz=oz+(brng()-0.5)*CHUNK*0.94;
            const nat=naturalHeight(gx,gz);
            if(nat<SEA+1.4 || nat>100) continue;
            const r=roadInfo(gx,gz); if(r.d<CARVE_R/2+2) continue;
            const e=1.5, slope=(Math.abs(naturalHeight(gx+e,gz)-naturalHeight(gx-e,gz))+Math.abs(naturalHeight(gx,gz+e)-naturalHeight(gx,gz-e)))/(2*e);
            if(slope>0.4) continue;
            const forest=forestAt(gx,gz);
            if(forest>0.6 && brng()<forest) continue;
            dummy.position.set(gx,nat-0.05,gz);
            const s=0.6+brng()*1.4; dummy.scale.set(s,s*(0.7+brng()*0.3),s);
            dummy.rotation.set(brng()*0.3,brng()*6.28,brng()*0.3);
            dummy.updateMatrix(); bushM.push(dummy.matrix.clone());
        }
    }
    const gd=Math.hypot(pos.x-ox,pos.z-oz)>CHUNK*6?density*0.5:density;
    // ── grass ──
    {
        const grng=mulberry32((cx*911)^(cz*4703)^7);
        for(let i=0;i<Math.floor(350*gd);i++){
            const gx=ox+(grng()-0.5)*CHUNK*0.94, gz=oz+(grng()-0.5)*CHUNK*0.94;
            const nat=naturalHeight(gx,gz);
            if(nat<SEA+1.4 || nat>78) continue;
            const r=roadInfo(gx,gz);
            if(r.d<CARVE_R/2) continue;
            if(r.d<CARVE_R/2+4 && grng()>(r.d-CARVE_R/2)/4) continue;
            const e=1.5, slope=(Math.abs(naturalHeight(gx+e,gz)-naturalHeight(gx-e,gz))+Math.abs(naturalHeight(gx,gz+e)-naturalHeight(gx,gz-e)))/(2*e);
            if(slope>0.5) continue;
            if(slope>0.3 && grng()>(0.5-slope)/0.2) continue;
            grassPts.push(gx,nat,gz);
        }
    }
    // ── small grass ──
    {
        const grng=mulberry32((cx*911)^(cz*4703)^13);
        for(let i=0;i<Math.floor(350*gd);i++){
            const gx=ox+(grng()-0.5)*CHUNK*0.94, gz=oz+(grng()-0.5)*CHUNK*0.94;
            const nat=naturalHeight(gx,gz);
            if(nat<SEA+1.4 || nat>78) continue;
            const r=roadInfo(gx,gz);
            if(r.d<CARVE_R/2) continue;
            if(r.d<CARVE_R/2+4 && grng()>(r.d-CARVE_R/2)/4) continue;
            const e=1.5, slope=(Math.abs(naturalHeight(gx+e,gz)-naturalHeight(gx-e,gz))+Math.abs(naturalHeight(gx,gz+e)-naturalHeight(gx,gz-e)))/(2*e);
            if(slope>0.5) continue;
            if(slope>0.3 && grng()>(0.5-slope)/0.2) continue;
            grassSmallPts.push(gx,nat,gz);
        }
    }

    // per-instance colour variation sells "real forest" for the cost of one
    // small attribute buffer; hueJit skews red/blue slightly for green hues
    function instanced(geoP,mat,mats,cast,tintLo,tintHi,hueJit){
        if(!mats.length) return;
        const im=new THREE.InstancedMesh(geoP,mat,mats.length);
        for(let i=0;i<mats.length;i++){
            im.setMatrixAt(i,mats[i]);
            const v=(tintLo??0.85)+rng()*((tintHi??1.15)-(tintLo??0.85));
            const j=(rng()-0.5)*(hueJit??0);
            _tintC.setRGB(v*(1+j), v, v*(1-j));
            im.setColorAt(i,_tintC);
        }
        im.instanceMatrix.needsUpdate=true; im.castShadow=cast; im.receiveShadow=false;
        im.frustumCulled=true; scene.add(im); rec.objs.push(im);
    }
    if(lod){
        instanced(lodPineGeo, pineMat, pineM, false, 0.8, 1.15, 0.14);
        instanced(lodLeafGeo, leafMat, leafM, false, 0.82, 1.2, 0.2);
        instanced(lodLeafGeo, bigLeafMat, bigLeafM, false, 0.82, 1.2, 0.2);
        instanced(lodRockGeo, rockMat, rockM, false, 0.75, 1.2, 0.05);
    } else {
        instanced(trunkGeo, trunkMat, pineM.concat(leafM).concat(bigLeafM), true, 0.85, 1.1, 0.06);
        instanced(pineCanGeo, pineMat, pineM, true, 0.8, 1.15, 0.14);
        instanced(leafCanGeo, leafMat, leafM, true, 0.82, 1.2, 0.2);
        instanced(bigLeafGeo, bigLeafMat, bigLeafM, true, 0.82, 1.2, 0.2);
        instanced(rockGeo, rockMat, rockM, true, 0.75, 1.2, 0.05);
        instanced(bushGeo, bushMat, bushM, true, 0.78, 1.22, 0.22);

        // per-blade colour: dry straw yellows through lush greens
        function grassField(pts, sMin, sRange){
            const n=pts.length/3;
            const im=new THREE.InstancedMesh(bladeGeo, grassMat, n);
            const d=new THREE.Object3D();
            for(let i=0;i<n;i++){
                d.position.set(pts[i*3],pts[i*3+1],pts[i*3+2]);
                const s=sMin+Math.random()*sRange; d.scale.set(s, s*(1.0+Math.random()*1.1), s);
                d.rotation.set(0,Math.random()*6.28,(Math.random()-0.5)*0.2); d.updateMatrix();
                im.setMatrixAt(i,d.matrix);
                const dry=Math.random();
                _tintC.setRGB(0.85+dry*0.45, 0.9+Math.random()*0.25, 0.65+ (1-dry)*0.3);
                im.setColorAt(i,_tintC);
            }
            im.instanceMatrix.needsUpdate=true; im.castShadow=false; im.receiveShadow=false;
            scene.add(im); rec.objs.push(im);
        }
        if(grassPts.length) grassField(grassPts, 0.7, 1.3);
        if(grassSmallPts.length) grassField(grassSmallPts, 0.35, 0.65);
    }

    collideByChunk.set(cx+','+cz, collide);
    } else {
        collideByChunk.set(cx+','+cz, []);
    }
    return rec;
}

let camChunkX=0, camChunkZ=0;
let _lastNeedCX=-9999, _lastNeedCZ=-9999;
const _cachedNeed=new Set();
const _chunkBuildQueue=new Map();
const _upgrade21=[], _upgrade10=[];
const _upgrading=new Set();
let _chunkTick=0;
function updateChunks(px,pz){
    const cx=Math.round(px/CHUNK), cz=Math.round(pz/CHUNK);
    camChunkX=px/CHUNK; camChunkZ=pz/CHUNK;
    // need-set and every LOD distance depend only on the chunk cell — nothing
    // below can change until the player crosses into a new cell, so skip the
    // full ~2×(2·VIEW_R+1)² scan on the frames in between
    if(cx===_lastNeedCX && cz===_lastNeedCZ) return;
    _lastNeedCX=cx; _lastNeedCZ=cz;
    _cachedNeed.clear();
    for(let dx=-VIEW_R;dx<=VIEW_R;dx++) for(let dz=-VIEW_R;dz<=VIEW_R;dz++){
        _cachedNeed.add((cx+dx)+','+(cz+dz));
    }
    const need=_cachedNeed;
    for(const [k,rec] of chunks){
        if(!need.has(k)){
            for(const o of rec.objs){ scene.remove(o); o.geometry?.dispose?.(); }
            chunks.delete(k); collideByChunk.delete(k);
        } else {
            const [x,z]=k.split(',').map(Number);
            const dist=Math.max(Math.abs(x-cx),Math.abs(z-cz));
            const lod=dist>FAR_LOD_R?2:(dist>LOD_R?1:0);
            if(lod<rec.lod && !_upgrading.has(k)){
                (rec.lod===2?_upgrade21:_upgrade10).push({key:k,x,z});
                _upgrading.add(k);
            } else if(lod>rec.lod){
                // keep old chunk visible until the new lower-LOD one is built
                _chunkBuildQueue.set(k,{x,z,lod});
            }
        }
    }
    for(const k of need){
        if(!chunks.has(k) && !_chunkBuildQueue.has(k)){
            const [x,z]=k.split(',').map(Number);
            const dist=Math.max(Math.abs(x-cx),Math.abs(z-cz));
            const lod=dist>FAR_LOD_R?2:(dist>LOD_R?1:0);
            _chunkBuildQueue.set(k,{x,z,lod});
        }
    }
}

function regenerateWorld(epoch) {
    worldSeed = epoch;
    document.getElementById('loading').classList.remove('hidden');
    // Clear all existing chunks
    for (const [k, rec] of chunks) {
        for (const o of rec.objs) { scene.remove(o); o.geometry?.dispose?.(); }
    }
    chunks.clear();
    collideByChunk.clear();
    // Clear road data
    roadWP.length = 0;
    roadHash.clear();
    rGenX = 0; rGenZ = 0; rGenA = 0; rGenH = 0; rGenI = 0; _roadBias = 0;
    if (roadMesh) { scene.remove(roadMesh); roadMesh.geometry.dispose(); roadMesh = null; }
    if (lineMesh) { scene.remove(lineMesh); lineMesh.geometry.dispose(); lineMesh = null; }
    roadBuiltIdx = -99999;
    _chunkBuildQueue.clear();
    _upgrade21.length=0; _upgrade10.length=0; _upgrading.clear();
    // Reset tracks
    trackCX = 0; trackCZ = 0;
    resetTrackMaps();
    if(trackOverlay){ scene.remove(trackOverlay); trackOverlay.geometry.dispose(); trackOverlay = null; }
    initTrackOverlay();
    // Rebuild road & queue all chunks
    roadInit();
    resetCar();
    roadExtend(pos.x, pos.z);
    updateChunks(pos.x, pos.z);
    // Build only the player's chunk synchronously (so car has ground)
    const _ck=Math.round(pos.x/CHUNK)+','+Math.round(pos.z/CHUNK);
    if(_chunkBuildQueue.has(_ck)){
        const _job=_chunkBuildQueue.get(_ck);
        _chunkBuildQueue.delete(_ck);
        chunks.set(_ck, buildChunk(_job.x,_job.z,_job.lod));
    }
    rebuildRoad(0);
    roadBuiltIdx = 0;
    waterTime = 0;
    camPos.set(pos.x, pos.y + 6, pos.z - 10);
    // loading stays visible until processChunkQueue reaches 50 chunks
    chatAdd('Uusi maailma generoitu');
}

// ── Visible road surface (streamed asphalt ribbon + centre line) ──
const roadSurfMat = new THREE.MeshStandardMaterial({ color:0x33363c, roughness:0.9, metalness:0, side:THREE.DoubleSide });
const lineSurfMat = new THREE.MeshBasicMaterial({ color:0xf0e8cc, side:THREE.DoubleSide });
let roadMesh=null, lineMesh=null, roadBuiltIdx=-99999;
function buildRibbon(a,b,halfW,yOff){
    const v=[], idx=[]; let vc=0;
    for(let i=a;i<b;i++){
        const p=roadWP[i], q=roadWP[i+1]; if(!p||!q) continue;
        const dx=q.x-p.x, dz=q.z-p.z; const l=Math.hypot(dx,dz)||1;
        const nx=-dz/l, nz=dx/l;
        // averaged normals at endpoints to close gaps on curves
        const pm=roadWP[i-1], qn=roadWP[i+2];
        let nxp=nx, nzp=nz;
        if(pm){ const dxp=p.x-pm.x, dzp=p.z-pm.z, lp=Math.hypot(dxp,dzp)||1;
            nxp=nx-dzp/lp; nzp=nz+dxp/lp; const ln=Math.hypot(nxp,nzp)||1; nxp/=ln; nzp/=ln; }
        let nxq=nx, nzq=nz;
        if(qn){ const dxq=qn.x-q.x, dzq=qn.z-q.z, lq=Math.hypot(dxq,dzq)||1;
            nxq=nx-dzq/lq; nzq=nz+dxq/lq; const ln=Math.hypot(nxq,nzq)||1; nxq/=ln; nzq/=ln; }
        const cur=vc;
        v.push(p.x+nxp*halfW, getHeight(p.x+nxp*halfW, p.z+nzp*halfW)+yOff, p.z+nzp*halfW);
        v.push(p.x-nxp*halfW, getHeight(p.x-nxp*halfW, p.z-nzp*halfW)+yOff, p.z-nzp*halfW);
        v.push(q.x+nxq*halfW, getHeight(q.x+nxq*halfW, q.z+nzq*halfW)+yOff, q.z+nzq*halfW);
        v.push(q.x-nxq*halfW, getHeight(q.x-nxq*halfW, q.z-nzq*halfW)+yOff, q.z-nzq*halfW);
        vc+=4;
        idx.push(cur, cur+2, cur+1, cur+1, cur+2, cur+3);
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v,3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
}
function rebuildRoad(centerIdx){
    const a=Math.max(0, centerIdx-120), b=Math.min(roadWP.length-1, centerIdx+360);
    if(b<=a) return;
    const rg=buildRibbon(a,b,ROAD_HALF,0.06);
    const lg=buildRibbon(a,b,0.16,0.09);
    if(roadMesh){ scene.remove(roadMesh); roadMesh.geometry.dispose(); }
    if(lineMesh){ scene.remove(lineMesh); lineMesh.geometry.dispose(); }
    roadMesh=new THREE.Mesh(rg, roadSurfMat); roadMesh.receiveShadow=true; roadMesh.renderOrder=0; scene.add(roadMesh);
    lineMesh=new THREE.Mesh(lg, lineSurfMat); scene.add(lineMesh);
}

// ════════════════════════════════════════════════════════════
//  CAR
// ════════════════════════════════════════════════════════════
const car = new THREE.Group();
car.rotation.order = 'YXZ';   // yaw first, then pitch/roll in the car's own frame
// Body colour (used by colour picker and ghost cars)
const bodyMat = new THREE.MeshPhysicalMaterial({ color:0x2b6cc4, metalness:0.55, roughness:0.35, clearcoat:1, clearcoatRoughness:0.2 });

// Load BMW 3D model
(async () => {
    try {
        const mtlLoader = new MTLLoader();
        mtlLoader.setResourcePath(window.__CAR_URL ? window.__CAR_URL.slice(0, window.__CAR_URL.lastIndexOf('/') + 1) : 'auto/');
        const materials = await mtlLoader.loadAsync(
            window.__CAR_URL ? window.__CAR_URL.replace('/car.obj', '/car.mtl') : 'auto/car.obj'
        );
        materials.preload();
        const objLoader = new OBJLoader();
        objLoader.setMaterials(materials);
        const model = await objLoader.loadAsync(window.__CAR_URL || 'auto/car.obj');
        // the OBJ is modelled nose towards +X — turn it so the nose points to
        // local +Z, the forward axis the physics and wheel layout assume
        model.rotation.y = -Math.PI/2;
        // Center the model (it's exported offset from origin; bbox after rotation)
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center);
        // Adjust height so car sits at RIDE_H above ground
        const size = box.getSize(new THREE.Vector3());
        model.position.y += RIDE_H + 0.15;
        model.userData.isCarModel = true;
        model.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        car.add(model);
        applyCarColor(carColorHex);
        if(window.__pendingColor) applyCarColor(window.__pendingColor);
    } catch (e) {
        console.warn('BMW model load failed, using detailed car:', e.message);
        const trimMat = new THREE.MeshStandardMaterial({ color:0x14161a, metalness:0.4, roughness:0.5 });
        const glassMat = new THREE.MeshPhysicalMaterial({ color:0x101820, metalness:0, roughness:0.08, transparent:true, opacity:0.55 });
        const chromeMat = new THREE.MeshStandardMaterial({ color:0xcdd2da, metalness:0.95, roughness:0.15 });
        const hlMat = new THREE.MeshStandardMaterial({ color:0xfffbe6, emissive:0xfff4c0, emissiveIntensity:0.6 });
        const tlMat = new THREE.MeshStandardMaterial({ color:0x330000, emissive:0xff1500, emissiveIntensity:0.5 });
        const tireMat = new THREE.MeshStandardMaterial({ color:0x121212, roughness:0.85, metalness:0 });
        const rimMat = new THREE.MeshStandardMaterial({ color:0x9aa0aa, metalness:0.9, roughness:0.25 });
        const body = new THREE.Group();
        const low = new THREE.Mesh(new THREE.BoxGeometry(1.86,0.5,4.15), bodyMat); low.position.y=0.62; low.castShadow=true; body.add(low);
        const nose = new THREE.Mesh(new THREE.BoxGeometry(1.8,0.32,1.0,1,1,1), bodyMat); nose.position.set(0,0.55,1.75); nose.rotation.x=-0.12; nose.castShadow=true; body.add(nose);
        const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.66,0.52,2.0), bodyMat); cabin.position.set(0,1.02,-0.15); cabin.castShadow=true; body.add(cabin);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5,0.14,1.7), bodyMat); roof.position.set(0,1.3,-0.15); roof.castShadow=true; body.add(roof);
        const wsG = new THREE.Mesh(new THREE.BoxGeometry(1.56,0.5,0.06), glassMat); wsG.position.set(0,1.05,0.9); wsG.rotation.x=0.55; body.add(wsG);
        const rgG = new THREE.Mesh(new THREE.BoxGeometry(1.54,0.46,0.06), glassMat); rgG.position.set(0,1.05,-1.12); rgG.rotation.x=-0.5; body.add(rgG);
        for(const s of [-1,1]){ const sw=new THREE.Mesh(new THREE.BoxGeometry(0.05,0.36,1.5), glassMat); sw.position.set(s*0.82,1.06,-0.15); body.add(sw); }
        const fb = new THREE.Mesh(new THREE.BoxGeometry(1.9,0.34,0.35), trimMat); fb.position.set(0,0.42,2.06); body.add(fb);
        const rb = new THREE.Mesh(new THREE.BoxGeometry(1.9,0.34,0.35), trimMat); rb.position.set(0,0.42,-2.06); body.add(rb);
        for(const s of [-1,1]){ const sk=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.16,3.2), trimMat); sk.position.set(s*0.94,0.34,0); body.add(sk); }
        const gr = new THREE.Mesh(new THREE.BoxGeometry(0.9,0.16,0.06), chromeMat); gr.position.set(0,0.5,2.24); body.add(gr);
        for(const s of [-1,1]){
            const hl=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.16,0.08), hlMat); hl.position.set(s*0.66,0.6,2.15); body.add(hl);
            const tl=new THREE.Mesh(new THREE.BoxGeometry(0.3,0.16,0.08), tlMat); tl.position.set(s*0.66,0.66,-2.14); body.add(tl);
        }
        for(const s of [-1,1]){ const m=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.1,0.12), bodyMat); m.position.set(s*1.02,0.95,0.75); body.add(m); }
        car.add(body);
        const wheelGeo = new THREE.CylinderGeometry(WHEEL_R,WHEEL_R,0.26,18).rotateZ(Math.PI/2);
        const rimGeo = new THREE.CylinderGeometry(WHEEL_R*0.6,WHEEL_R*0.6,0.28,10).rotateZ(Math.PI/2);
        for(let i=0;i<wpos.length;i++){
            const [wx,wz]=wpos[i];
            const tire=new THREE.Mesh(wheelGeo, tireMat); tire.position.set(wx, WHEEL_R, wz); tire.castShadow=true; car.add(tire);
            const rim=new THREE.Mesh(rimGeo, rimMat); rim.position.set(wx, WHEEL_R, wz); car.add(rim);
            if(wheels[i]){ wheels[i].spin=tire; wheels[i].rim=rim; }
        }
    }
})();

// wheels
const wheels=[];
const wpos=[[ TRACK/2, WHEELBASE/2],[-TRACK/2, WHEELBASE/2],[ TRACK/2,-WHEELBASE/2],[-TRACK/2,-WHEELBASE/2]];
// Keep invisible wheel groups for physics (suspension sampling)
// The OBJ model provides the visual wheels
for(const [wx,wz] of wpos){
    const g=new THREE.Group();
    g.position.set(wx, WHEEL_R, wz);
    g.visible = false;
    car.add(g); wheels.push({ group:g, spin:null, rim:null, x:wx, z:wz, front: wz>0 });
}
scene.add(car);

// dust particles
const MAXP=400;
const pPos=new Float32Array(MAXP*3), pVel=new Float32Array(MAXP*3), pLife=new Float32Array(MAXP);
let pIdx=0;
const pGeo=new THREE.BufferGeometry(); pGeo.setAttribute('position', new THREE.BufferAttribute(pPos,3));
const pMat=new THREE.PointsMaterial({ color:0xbdb097, size:0.5, transparent:true, opacity:0.55, depthWrite:false });
scene.add(new THREE.Points(pGeo,pMat));
function emit(x,y,z,n){
    for(let i=0;i<n;i++){ const j=pIdx*3;
        pPos[j]=x+(Math.random()-0.5)*0.6; pPos[j+1]=y+Math.random()*0.2; pPos[j+2]=z+(Math.random()-0.5)*0.6;
        pVel[j]=(Math.random()-0.5)*2.5; pVel[j+1]=0.4+Math.random(); pVel[j+2]=(Math.random()-0.5)*2.5;
        pLife[pIdx]=0.5+Math.random()*0.6; pIdx=(pIdx+1)%MAXP;
    }
}

// ── tire tracks ──
const TRACK_POOL=300;
const trackPool=[];
const trackMat=new THREE.MeshBasicMaterial({ color:0x1a1a1a, transparent:true, opacity:0.3, depthWrite:false, blending:THREE.MultiplyBlending });
const trackGeo=new THREE.BoxGeometry(0.08,0.008,0.48);
let trackTimer=0, trackIdx=0;
for(let i=0;i<TRACK_POOL;i++){
    const m=new THREE.Mesh(trackGeo, trackMat.clone());
    m.visible=false; m.userData.life=0;
    scene.add(m); trackPool.push(m);
}
function addTrack(wx,wz,ang){
    const m=trackPool[trackIdx%TRACK_POOL]; trackIdx++;
    m.position.set(wx, getHeight(wx,wz)+0.004, wz);
    m.rotation.set(0,ang,0);
    m.visible=true; m.userData.life=3.5; m.material.opacity=0.3;
}
function updateTracks(dt){
    for(const m of trackPool){
        if(!m.visible) continue;
        m.userData.life-=dt;
        if(m.userData.life<=0){ m.visible=false; }
        else { m.material.opacity=0.3*(m.userData.life/3.5); }
    }
}

// ════════════════════════════════════════════════════════════
//  PHYSICS STATE  (velocity vector follows heading → car goes where it points)
// ════════════════════════════════════════════════════════════
let heading = roadWP[1] ? Math.atan2(roadWP[1].x-roadWP[0].x, roadWP[1].z-roadWP[0].z) : 0;
const pos = new THREE.Vector3(roadWP[0].x, getHeight(roadWP[0].x,roadWP[0].z), roadWP[0].z);
let vx=0, vz=0;                       // world-space velocity
let bodyPitch=0, bodyRoll=0, bodyY=pos.y+RIDE_H, vy=0;
let gear=0, rpm=IDLE_RPM, steerVis=0, wheelSpin=0;
let waterTime=0;   // seconds the car has spent below the water line
let carColorHex='#2b6cc4';
let netTimer=0;
const gearSpeeds=[0,12,24,36,48,MAX_SPEED+1];
const gearNames=['N','1','2','3','4','5'];

// ── Controls ──
const keys={f:0,b:0,l:0,r:0,hb:0};
addEventListener('keydown',e=>{
    if(_canDrive){
        if(e.code==='KeyW'||e.code==='ArrowUp')keys.f=1;
        if(e.code==='KeyS'||e.code==='ArrowDown')keys.b=1;
        if(e.code==='KeyA'||e.code==='ArrowLeft')keys.l=1;
        if(e.code==='KeyD'||e.code==='ArrowRight')keys.r=1;
        if(e.code==='Space'){keys.hb=1;e.preventDefault();}
    }
    if('WSADwsad'.includes(e.key)) chatHide();
    if(e.code==='KeyC')cycleCam();
    if(e.code==='KeyR')resetCar();
});
addEventListener('keyup',e=>{
    if(e.code==='KeyW'||e.code==='ArrowUp')keys.f=0;
    if(e.code==='KeyS'||e.code==='ArrowDown')keys.b=0;
    if(e.code==='KeyA'||e.code==='ArrowLeft')keys.l=0;
    if(e.code==='KeyD'||e.code==='ArrowRight')keys.r=0;
    if(e.code==='Space')keys.hb=0;
});
let touchSteer=0,touchAccel=0;
renderer.domElement.addEventListener('touchmove',hT,{passive:false});
renderer.domElement.addEventListener('touchstart',hT,{passive:false});
renderer.domElement.addEventListener('touchend',()=>{touchSteer=touchAccel=0;});
function hT(e){ e.preventDefault(); if(!e.touches.length)return; let s=0,a=0;
    for(const t of e.touches){ s+=(t.clientX-innerWidth/2)/(innerWidth/2); a+=(innerHeight/2-t.clientY)/(innerHeight/2); }
    if(_canDrive){ touchSteer=clamp(s/e.touches.length,-1,1); touchAccel=clamp(a/e.touches.length,-1,1); }
}

function resetCar(){
    // nearest road waypoint, aligned with road
    let bi=0,bd=1e18;
    for(let i=0;i<roadWP.length;i++){ const d=(roadWP[i].x-pos.x)**2+(roadWP[i].z-pos.z)**2; if(d<bd){bd=d;bi=i;} }
    const p=roadWP[bi], q=roadWP[bi+1]||roadWP[bi-1]||p;
    pos.set(p.x, p.y, p.z);
    heading=Math.atan2(q.x-p.x, q.z-p.z);
    camHeading=heading;
    vx=vz=0; vy=0; bodyY=p.y+RIDE_H; gear=0;
}

// ── Camera ──
let camMode=0; // 0 chase, 1 near, 2 hood
let camHeading=0;
let _lastBlur=-1;
const camPos=new THREE.Vector3().copy(camera.position);
function cycleCam(){ camMode=(camMode+1)%3; setCamButtons(); }

// ════════════════════════════════════════════════════════════
//  UPDATE
// ════════════════════════════════════════════════════════════
function update(dt){
    if(dt>0.05)dt=0.05;
    let steer=0, throttle=0, brake=0;
    if(keys.l)steer+=1; if(keys.r)steer-=1;
    if(keys.f)throttle=1; if(keys.b)brake=1;
    if(Math.abs(touchSteer)>0.12)steer=touchSteer;
    if(touchAccel>0.12)throttle=touchAccel; else if(touchAccel<-0.12)brake=-touchAccel;
    const hb=keys.hb;

    // forward / right basis
    const F={x:Math.sin(heading), z:Math.cos(heading)};
    const R={x:Math.cos(heading), z:-Math.sin(heading)};
    let vf = vx*F.x + vz*F.z;         // speed along car forward
    let vl = vx*R.x + vz*R.z;         // lateral (sideways) speed
    const vabs=Math.abs(vf);
    if(vabs>0.5) totalDriveM+=vabs*dt;

    // road check
    const rinfo=roadInfo(pos.x,pos.z);
    const onRoad = rinfo.d < ROAD_HALF+1.5;
    if(rinfo.i>=0) _miniRoadIdx=rinfo.i;

    // ── ground contact: tire forces only exist when the wheels touch ──
    const groundHere = getHeight(pos.x,pos.z);
    const onGround = bodyY <= groundHere + RIDE_H + 0.35;

    // terrain slope under the car (sampled ±1.5 m along each axis)
    const slopeF = Math.atan2(getHeight(pos.x+F.x*1.5,pos.z+F.z*1.5) - getHeight(pos.x-F.x*1.5,pos.z-F.z*1.5), 3);
    const slopeR = Math.atan2(getHeight(pos.x+R.x*1.5,pos.z+R.z*1.5) - getHeight(pos.x-R.x*1.5,pos.z-R.z*1.5), 3);

    // ── 1st gear when throttle pressed (before torque calc) ──
    if(gear===0 && throttle>0) gear=1;
    // ── engine torque ──
    let driveForce = 0;
    if(onGround && gear>0 && throttle>0){
        const tr = Math.max(0, 1 - ((rpm - 3500) / 3500) ** 2);
        const eTorque = ENGINE_MAX_TORQUE * tr;
        const wTorque = eTorque * throttle * GEAR_RATIOS[gear] * FINAL_DRIVE * DRIVETRAIN_EFF;
        driveForce = wTorque / WHEEL_R;
    }
    // ── brakes (tire friction caps the usable brake force: max decel ≈ μ·g) ──
    const mu = onRoad ? TIRE_FRICTION_ROAD : TIRE_FRICTION_OFFROAD;
    const brakeForce = (onGround && brake>0)
        ? Math.min(MAX_BRAKE_TORQUE*brake/WHEEL_R, mu*CAR_MASS*GRAVITY) * Math.sign(vf) : 0;
    // ── reverse ──
    let revForce = 0;
    if(onGround && brake>0 && vf<0.3 && vf>-0.3 && gear===0) revForce = -3000/WHEEL_R * brake;
    // ── drag ──
    const dragForce = 0.5 * AIR_DENSITY * DRAG_COEF * FRONTAL_AREA * vf * Math.abs(vf);
    // ── rolling resistance ──
    const rollForce = onGround ? ROLLING_RESIST * CAR_MASS * GRAVITY * Math.sign(vf) : 0;
    // gravity component along the slope (car rolls downhill, climbs slower)
    const slopeForce = onGround ? -CAR_MASS * GRAVITY * Math.sin(slopeF) : 0;
    const longForce = driveForce - brakeForce + revForce - dragForce - rollForce + slopeForce;
    const vfPrev = vf;
    vf += longForce / CAR_MASS * dt;
    // brakes stop the car — they must not push it through zero into reverse
    if(brake>0 && gear>0 && vfPrev>0 && vf<0) vf=0;
    vf = clamp(vf, -MAX_REVERSE, MAX_SPEED);
    if(throttle===0 && brake===0 && Math.abs(vf)<0.15 && Math.abs(slopeF)<0.05) vf=0;

    // ── lateral grip (friction circle) — tires grip only on the ground ──
    if(onGround){
        const maxLatForce = mu * CAR_MASS * GRAVITY;
        const longUtil = Math.abs(longForce) / (maxLatForce + 1);
        const latFactor = Math.max(0, 1 - longUtil*longUtil);
        vl += -GRAVITY * Math.sin(slopeR) * dt;   // sideways slope pulls the car downhill
        vl -= vl * clamp(maxLatForce * latFactor / (Math.abs(vl)*CAR_MASS + 1) * dt, 0, 1);
    }

    // ── steering (front wheels can only turn the car while touching the ground) ──
    const steerAngle = steer * MAX_STEER_ANGLE * (1 - clamp(Math.abs(vf)/25, 0, 0.7));
    if(onGround){
        const dir = vf >= 0 ? 1 : -1;
        if(Math.abs(vf) > 1){
            heading += Math.tan(steerAngle) * vf / WHEELBASE * dt;
        } else {
            heading += steerAngle * 3 * dir * dt;
        }
    }

    // recompose velocity from (possibly rotated) basis
    const F2={x:Math.sin(heading), z:Math.cos(heading)};
    const R2={x:Math.cos(heading), z:-Math.sin(heading)};
    vx = F2.x*vf + R2.x*vl;
    vz = F2.z*vf + R2.z*vl;
    pos.x += vx*dt; pos.z += vz*dt;

    // ── peer collision ──
    for(const [,p] of peers){
        const dx=pos.x-p.group.position.x, dz=pos.z-p.group.position.z;
        const d=Math.hypot(dx,dz); const min=2.6;
        if(d<min&&d>0.01){ const o=(min-d)/d; pos.x+=dx*o; pos.z+=dz*o;
            const nx=dx/d, nz=dz/d;
            const vdot=vx*nx+vz*nz; if(vdot<0){ vx-=nx*vdot; vz-=nz*vdot; playCollision(); } }
    }

    // ── tree / rock collision (every 2nd frame) ──
    const colR=3.5;
    const ckx=Math.round(pos.x/CHUNK), ckz=Math.round(pos.z/CHUNK);
    _colFrame++;
    // ±1 chunk = 20 m reach, far beyond any collider radius (max ~8 m)
    if(_colFrame&1) for(let dx=-1;dx<=1;dx++) for(let dz=-1;dz<=1;dz++){
        const col=collideByChunk.get((ckx+dx)+','+(ckz+dz));
        if(!col) continue;
        for(const t of col){
            const odx=pos.x-t.x, odz=pos.z-t.z;
            const d=Math.hypot(odx,odz); const min=t.r+colR;
            if(d<min&&d>0.01){ const o=(min-d)/d; pos.x+=odx*o; pos.z+=odz*o;
                const nx=odx/d, nz=odz/d;
                const vdot=vx*nx+vz*nz; if(vdot<0){ vx-=nx*vdot; vz-=nz*vdot; playCollision(); } }
        }
    }

    // ── suspension: sample ground under each wheel ──
    let sum=0, fr=0, re=0, lf=0, ri=0, supportY=-1e9;
    for(const w of wheels){
        const wxg = pos.x + F2.x*w.z + R2.x*w.x;
        const wzg = pos.z + F2.z*w.z + R2.z*w.x;
        const gy = getHeight(wxg,wzg);
        w.gy=gy; sum+=gy; if(gy>supportY) supportY=gy;
        if(w.z>0) fr+=gy; else re+=gy;
        if(w.x>0) ri+=gy; else lf+=gy;
    }

    // ── tire tracks (rear wheels only, on solid ground) ──
    let rearOnRoad = false;
    if(vabs>0.5) for(const w of wheels) if(w.z<0){   // result only used when moving
        const wxg=pos.x+F2.x*w.z+R2.x*w.x, wzg=pos.z+F2.z*w.z+R2.z*w.x;
        if(roadInfo(wxg,wzg).d < ROAD_HALF+1.5) rearOnRoad = true;
    }
    if(vabs>0.5 && rearOnRoad){
        trackTimer+=dt;
        if(trackTimer>0.045){
            trackTimer=0;
            for(const w of wheels) if(w.z<0) addTrack(pos.x+F2.x*w.z+R2.x*w.x, pos.z+F2.z*w.z+R2.z*w.x, heading);
        }
    }
    const groundY=sum/4;
    // include the chassis midpoint so a long car straddling a crest can't dig in
    supportY=Math.max(supportY, getHeight(pos.x,pos.z));
    const tgtPitch = Math.atan2((re/2-fr/2), WHEELBASE);   // nose down when front lower
    const tgtRoll  = Math.atan2((lf/2-ri/2), TRACK);
    // dynamic lean from accel/brake and cornering
    const accelLean = (throttle>0?-0.5:0)+(brake>0? (vf>0?0.6:0):0);
    const corner = -clamp(vl/12,-1,1)*0.5;
    // ── vertical physics: gravity always, suspension only in wheel contact ──
    const targetY = supportY + RIDE_H;
    const springK = 90, dampK = 7.0;          // ~1.5 Hz spring, critical-ish damping
    const compression = targetY - bodyY;       // >0 = spring compressed
    vy -= GRAVITY * dt;                        // free fall at 9.81 m/s²
    if (compression > -0.12) {                 // wheels in contact (12 cm droop travel)
        // preloaded spring: carries the car's weight at zero compression
        vy += (GRAVITY + springK * compression) * dt;
        vy -= vy * dampK * dt;
    }
    bodyY += vy * dt;
    // hard floor — never below any ground sample; small energy loss on impact
    if (bodyY < supportY) {
        bodyY = supportY;
        if (vy < 0) vy = -vy * 0.15;
    }
    bodyPitch += (tgtPitch*0.7 + accelLean*0.06 - bodyPitch)*Math.min(1,8*dt);
    // terrain roll negated: in the unmirrored frame positive rotation.z lifts
    // the right (+x) side, but higher left wheels must lift the LEFT side
    bodyRoll  += (-tgtRoll*0.7 + corner - bodyRoll)*Math.min(1,8*dt);

    pos.y=groundY;
    car.position.set(pos.x, bodyY, pos.z);
    // +heading, same sign convention as the ghost cars — the old -heading
    // mirrored the model so it visibly turned opposite to the actual motion
    car.rotation.set(bodyPitch, heading, bodyRoll);

    // ── submerged too long → put the car back on the road ──
    if(groundY < SEA-0.4){ waterTime += dt; if(waterTime>5){ resetCar(); waterTime=0; } }
    else waterTime = 0;

    // wheels visual
    wheelSpin += vf*dt/WHEEL_R;
    steerVis += (steer*0.5 - steerVis)*Math.min(1,10*dt);
    for(const w of wheels){
        w.group.position.y = WHEEL_R + clamp(w.gy - supportY, -0.4, 0.02);
        w.group.rotation.set(0, w.front ? steerVis : 0, 0);
        if (w.spin) w.spin.rotation.x = wheelSpin;
        if (w.rim) w.rim.rotation.x = wheelSpin;
    }

    // ── persistent tracks + flatten ──
    // a stationary car repaints the same pixels, so skip both the canvas
    // draws and the two 1024² texture uploads until the car actually moves
    if(_canDrive && (vabs>0.05 || Math.abs(vl)>0.05)){
        const ws=TRACK_HALF*0.6;
        if(Math.abs(pos.x-trackCX)>ws||Math.abs(pos.z-trackCZ)>ws) recenterTrackMaps(pos.x,pos.z);
        const ca=heading, sa=Math.sin(ca), co=Math.cos(ca);
        for(const [ww,wz] of [[WHEELBASE/2,TRACK/2],[WHEELBASE/2,-TRACK/2],[-WHEELBASE/2,TRACK/2],[-WHEELBASE/2,-TRACK/2]]){
            const wx=pos.x+ww*co-wz*sa, wz2=pos.z+ww*sa+wz*co;
            drawWheelMark(wx,wz2,1);
        }
        if(++_trackUploadTick%3===0){ flattenTex.needsUpdate=true; trackTex.needsUpdate=true; }
    }

    // ── dust when sliding / offroad ──
    const sliding = Math.abs(vl)>2.5 || hb;
    if(vabs>6 && (sliding || !onRoad)){
        const n=Math.min(6, Math.floor(vabs/12)+1+(hb?2:0));
        emit(pos.x - F2.x*1.8, groundY, pos.z - F2.z*1.8, n);
    }
    for(let i=0;i<MAXP;i++){ if(pLife[i]>0){ pLife[i]-=dt; const j=i*3;
        pPos[j]+=pVel[j]*dt; pPos[j+1]+=pVel[j+1]*dt; pPos[j+2]+=pVel[j+2]*dt; pVel[j+1]-=2*dt;
    } else { pPos[i*3+1]=-999; } }
    pGeo.attributes.position.needsUpdate=true;
    updateTracks(dt);

    // ── gears / rpm ──
    let tg=gear;
    if(gear===0 && (vf>0.4 || throttle>0)) tg=1;
    else if(vabs>gearSpeeds[gear]+3 && gear<5) tg=gear+1;
    else if(gear>1 && vabs<gearSpeeds[gear-1]-3) tg=gear-1;
    if(vf<=0.2 && vabs<0.6) tg=0;
    gear=tg;
    if(gear===0){
        rpm = IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * Math.max(throttle, brake) * 0.3;
    } else {
        const wheelRps = vabs / (WHEEL_R * 2 * Math.PI);
        const engineRpmFromSpeed = wheelRps * 60 * GEAR_RATIOS[gear] * FINAL_DRIVE;
        if(throttle>0 && vabs<1){
            rpm += (REDLINE_RPM*0.9 - rpm) * throttle * dt * 2;
        } else {
            rpm = engineRpmFromSpeed;
            if(rpm < IDLE_RPM && throttle===0) rpm += (IDLE_RPM - rpm) * 0.1;
        }
    }
    rpm = clamp(rpm, 0, REDLINE_RPM);

    // ── audio ──
    if (!audioCtx) initAudio();
    updateAudio(rpm, throttle, vabs, onRoad, Math.abs(vl), hb);

    // ── camera ──
    updateCamera(dt, vabs, F2);

    // sun / shadow follow
    sun.position.set(pos.x+sunDir.x*120, pos.y+sunDir.y*120, pos.z+sunDir.z*120);
    sun.target.position.set(pos.x,pos.y,pos.z);

    // water follows camera
    ensureWater();
    water.position.x=camera.position.x; water.position.z=camera.position.z;
    waterUniforms.time.value += dt;

    // world streaming
    roadExtend(pos.x,pos.z);
    updateChunks(pos.x,pos.z);
    if(rinfo.i>=0 && Math.abs(rinfo.i-roadBuiltIdx)>30){ rebuildRoad(rinfo.i); roadBuiltIdx=rinfo.i; }

    // ── wind ──
    windTime += dt;
    grassWind.value = windTime;
    grassCarPos.value.copy(car.position);
    if(trackOverlay){ trackOverlay.position.set(trackCX, 0.08, trackCZ); }
    updateClouds(dt);
    updateBirds(dt);

    // ── multiplayer ──
    if(soloMode && !_soloApplied){
        _soloApplied = true;
        chatEl.classList.add('hidden'); chatReopen.classList.add('hidden');
        for(const [id,p] of peers){ scene.remove(p.group); p.nameTag?.remove(); }
        peers.clear();
    }
    if(!soloMode){
        netTimer+=dt;
        if(netTimer>0.04){ netTimer=0;
            net.publish({ x:+pos.x.toFixed(1), z:+pos.z.toFixed(1), h:+heading.toFixed(3), s:+vf.toFixed(1), c:carColorHex, n:playerName });
        }
    }
    updatePeers(dt);

    // ── world epoch check & clock ──
    worldClockTimer += dt;
    if (worldClockTimer > 1) {
        worldClockTimer = 0;
        const epoch = Math.floor(Date.now() / WORLD_MS);
        if (epoch !== worldEpoch) {
            worldEpoch = epoch;
            regenerateWorld(epoch);
        }
        const remaining = Math.max(0, (worldEpoch + 1) * WORLD_MS - Date.now());
        if (remaining <= 0) { worldClockEl.textContent = '00:00:00'; }
        else {
            const h = Math.floor(remaining / 3600000);
            const m = Math.floor((remaining % 3600000) / 60000);
            const s = Math.floor((remaining % 60000) / 1000);
            worldClockEl.textContent =
                String(h).padStart(2, '0') + ':' +
                String(m).padStart(2, '0') + ':' +
                String(s).padStart(2, '0');
        }
        localStorage.setItem('lastPlayed', String(Date.now()));
        document.getElementById('total-dist').textContent = (totalDriveM / 1000).toFixed(1);
    }

    // HUD
    updateNameTags();
    updateHUD(vf);
}

function updateCamera(dt, vabs, F){
    camHeading += (heading - camHeading) * Math.min(1, 8*dt);
    const cf = {x:Math.sin(camHeading), z:Math.cos(camHeading)};
    let dist, height, look;
    if(camMode===0){ dist=8.5+vabs/MAX_SPEED*3.5; height=3.4+vabs/MAX_SPEED*0.8; look=9; }
    else if(camMode===1){ dist=5.5; height=2.3; look=7; }
    else { dist=-0.2; height=1.35; look=12; }   // hood cam
    const tx=pos.x - cf.x*dist, tz=pos.z - cf.z*dist;
    const ty=(camMode===2? bodyY+height : Math.max(getHeight(tx,tz)+1.2, bodyY+height));
    // rigid horizontal follow — the camera can never trail away from behind the car;
    // only the smoothed camHeading gives it a natural swing in corners
    camPos.x = tx; camPos.z = tz;
    camPos.y += (ty - camPos.y) * (camMode===2 ? 1 : Math.min(1, 10*dt));
    if(camMode!==2){
        const minY=getHeight(camPos.x,camPos.z)+1.0; if(camPos.y<minY)camPos.y=minY;
    }
    camera.position.copy(camPos);
    camera.lookAt(pos.x+F.x*look, bodyY+1.2, pos.z+F.z*look);
    const fov = 62 + (vabs/MAX_SPEED)*2;
    const newFov = camera.fov + (fov-camera.fov)*Math.min(1,4*dt);
    if(Math.abs(newFov-camera.fov)>0.002){ camera.fov=newFov; camera.updateProjectionMatrix(); }
    // ── motion blur (write the style only when the value actually changes) ──
    const blur = Math.round(clamp((vabs/MAX_SPEED)*1.2, 0, 1.2)*50)/50;
    if(blur!==_lastBlur){ _lastBlur=blur; renderer.domElement.style.filter = blur ? `blur(${blur}px)` : ''; }
    // ── FPS / Ping display ──
    _fpsFrames++;
    const fpsNow=performance.now();
    if(fpsNow-_fpsTime>=1000){
        _fpsVal=Math.round(_fpsFrames*1000/(fpsNow-_fpsTime));
        _fpsFrames=0; _fpsTime=fpsNow;
    }
    if(_debugShow){
        _fpsEl.textContent=_fpsVal;
        _pingEl.textContent=net.isConnected()?(net.pingRtt||0):'--';
    }
}

// ════════════════════════════════════════════════════════════
//  HUD
// ════════════════════════════════════════════════════════════
const speedEl=document.getElementById('speed');
const gearEl=document.getElementById('gear');
let _fpsFrames=0, _fpsTime=performance.now(), _fpsVal=0, _debugShow=false, _hudSkip=0;
const _fpsEl=document.getElementById('fps-val'), _pingEl=document.getElementById('ping-val');
const _debugEl=document.getElementById('debug');
const miniCanvas=document.getElementById('minimap');
const miniCtx=miniCanvas.getContext('2d');
const _altEl=document.getElementById('altitude');
const _rpmFillEl=document.getElementById('rpm-fill');
let _lastSpeed=-1, _lastGear=-1, _lastAlt=-1e9, _lastRpmPct=-1;
function updateHUD(vf){
    const spd=Math.round(Math.abs(vf)*3.6);
    if(spd!==_lastSpeed){ _lastSpeed=spd; speedEl.textContent=spd; }
    if(gear!==_lastGear){ _lastGear=gear; gearEl.firstChild.textContent=gearNames[gear]; }
    const alt=Math.round(bodyY);
    if(alt!==_lastAlt){ _lastAlt=alt; _altEl.textContent=alt; }
    const rpmPct=Math.round(rpm / REDLINE_RPM * 200)/2;   // 0.5 % steps
    if(rpmPct!==_lastRpmPct){ _lastRpmPct=rpmPct; _rpmFillEl.style.width = rpmPct + '%'; }
    if(++_hudSkip%3===0){ drawMini(); drawCompass(); }
}
const MINI_R=280;
let _miniRoadIdx=0;
function drawMini(){
    const s=140, hs=s/2, c=miniCtx;
    c.clearRect(0,0,s,s); c.save();
    c.beginPath(); c.arc(hs,hs,hs,0,7); c.clip();
    // water backdrop tint
    c.fillStyle='rgba(30,60,80,0.35)'; c.fillRect(0,0,s,s);
    // heading-up projection
    const fX=Math.sin(heading), fZ=Math.cos(heading), rX=Math.cos(heading), rZ=-Math.sin(heading);
    // road — the ±45° heading clamp means waypoints further than ~35 indices
    // away can never lie inside MINI_R, so a ±100 window is always complete
    c.strokeStyle='rgba(240,240,245,0.8)'; c.lineWidth=2.4; c.beginPath();
    let started=false;
    const i0=Math.max(0,_miniRoadIdx-100), i1=Math.min(roadWP.length,_miniRoadIdx+100);
    for(let i=i0;i<i1;i++){
        const w=roadWP[i]; const dx=w.x-pos.x, dz=w.z-pos.z;
        if(dx*dx+dz*dz>MINI_R*MINI_R){ started=false; continue; }
        const sx=hs+(dx*rX+dz*rZ)/MINI_R*hs, sy=hs-(dx*fX+dz*fZ)/MINI_R*hs;
        if(!started){ c.moveTo(sx,sy); started=true; } else c.lineTo(sx,sy);
    }
    c.stroke(); c.restore();
    // car arrow (fixed, points up)
    c.fillStyle='#7fc4f0';
    c.beginPath(); c.moveTo(hs,hs-8); c.lineTo(hs-5,hs+6); c.lineTo(hs+5,hs+6); c.closePath(); c.fill();
}

// ── Compass with cardinal directions + peers ──
const compassCanvas = document.getElementById('compass');
const compassCtx = compassCanvas.getContext('2d');
const COMPASS_R = 48;
function drawCompass() {
    const c = compassCtx;
    const w = compassCanvas.width, h = compassCanvas.height;
    const cx = w/2, cy = h/2;
    c.clearRect(0, 0, w, h);
    // Rotated ring with N/E/S/W
    c.save();
    c.translate(cx, cy);
    c.rotate(-heading);
    // Tick marks
    c.strokeStyle = 'rgba(255,255,255,0.15)';
    c.lineWidth = 1;
    for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2;
        const inner = i % 9 === 0 ? COMPASS_R - 17 : COMPASS_R - 9;
        c.beginPath();
        c.moveTo(Math.sin(a) * inner, -Math.cos(a) * inner);
        c.lineTo(Math.sin(a) * (COMPASS_R - 4), -Math.cos(a) * (COMPASS_R - 4));
        c.stroke();
    }
    // Cardinal labels
    c.font = 'bold 15px "Segoe UI",sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const dirs = ['N', 'E', 'S', 'W'];
    const angles = [-Math.PI/2, 0, Math.PI/2, Math.PI];
    for (let i = 0; i < 4; i++) {
        const x = Math.sin(angles[i]) * (COMPASS_R - 9);
        const y = -Math.cos(angles[i]) * (COMPASS_R - 9);
        c.fillStyle = i === 0 ? '#f0e8cc' : 'rgba(255,255,255,0.4)';
        c.fillText(dirs[i], x, y);
    }
    c.restore(); // undo rotation
    // Center dot (self)
    c.beginPath(); c.arc(cx, cy, 3, 0, Math.PI*2);
    c.fillStyle = '#7fc4f0'; c.fill();
    // Peer dots
    for (const [, p] of peers) {
        const dx = p.tx - pos.x;
        const dz = p.tz - pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 3) continue;
        const angle = Math.atan2(dx, dz) - heading;
        const pr = Math.min(COMPASS_R - 5, 4 + dist * 0.08);
        c.beginPath();
        c.arc(cx + Math.sin(angle) * pr, cy - Math.cos(angle) * pr, 3, 0, Math.PI*2);
        c.fillStyle = p.color || '#ccc';
        c.fill();
    }
}

// ── Name tag positioning ──
const _proj = new THREE.Vector3();
function updateNameTags() {
    for (const [, p] of peers) {
        if (!p.nameTag) continue;
        _proj.set(p.tx, getHeight(p.tx, p.tz) + RIDE_H + 2.8, p.tz);
        _proj.project(camera);
        p.nameTag.style.display = _proj.z > 1 ? 'none' : '';
        if (_proj.z <= 1) {
            p.nameTag.style.left = ((_proj.x * 0.5 + 0.5) * innerWidth) + 'px';
            p.nameTag.style.top = ((-_proj.y * 0.5 + 0.5) * innerHeight - 10) + 'px';
        }
    }
}

// ════════════════════════════════════════════════════════════
//  SETTINGS UI
// ════════════════════════════════════════════════════════════
document.getElementById('settings-btn').addEventListener('click',()=>document.getElementById('panel').classList.toggle('open'));
const rd=document.getElementById('rd'), rdVal=document.getElementById('rd-val');
rd.addEventListener('input',()=>{ rdVal.textContent=rd.value; const v=+rd.value; if(v!==VIEW_R){ VIEW_R=v; _lastNeedCX=_lastNeedCZ=-9999; updateChunks(pos.x,pos.z); const _ck=Math.round(pos.x/CHUNK)+','+Math.round(pos.z/CHUNK); if(_chunkBuildQueue.has(_ck)){ const _job=_chunkBuildQueue.get(_ck); _chunkBuildQueue.delete(_ck); chunks.set(_ck, buildChunk(_job.x,_job.z,_job.lod)); } } });
const cpf=document.getElementById('chunks-pf'), cpfVal=document.getElementById('cpf-val');
cpfVal.textContent=cpf.value; _chunksPerFrame=+cpf.value;
cpf.addEventListener('input',()=>{ cpfVal.textContent=cpf.value; _chunksPerFrame=+cpf.value; });
cpf.addEventListener('change',()=>{ cpfVal.textContent=cpf.value; _chunksPerFrame=+cpf.value; });
const camSeg=document.getElementById('cam-seg');
function setCamButtons(){ [...camSeg.children].forEach(b=>b.classList.toggle('on',+b.dataset.cam===camMode)); }
[...camSeg.children].forEach(b=>b.addEventListener('click',()=>{ camMode=+b.dataset.cam; setCamButtons(); }));
const colors=[['#2b6cc4','Sininen'],['#c42b2b','Punainen'],['#e0e0e6','Valkoinen'],['#1a1c22','Musta'],['#2fa04a','Vihreä'],['#e0a020','Keltainen'],['#e06a20','Oranssi'],['#8a8f99','Hopea']];
const cc=document.getElementById('colors'); let selBtn=null;
for(const [hex,name] of colors){
    const b=document.createElement('button'); b.style.background=hex; b.title=name;
    if(hex==='#2b6cc4'){ b.classList.add('sel'); selBtn=b; }
    b.addEventListener('click',()=>{
        if(selBtn)selBtn.classList.remove('sel'); b.classList.add('sel'); selBtn=b;
        carColorHex=hex; applyCarColor(hex);
    });
    cc.appendChild(b);
}

// ── FPS / Ping toggle ──
document.getElementById('show-debug').addEventListener('change', function(){
    _debugShow=this.checked;
    _debugEl.classList.toggle('hidden',!_debugShow);
});



// ── Name prompt ──
const namePrompt = document.getElementById('name-prompt');
const nameInput = document.getElementById('name-input');
const nameBtn = document.getElementById('name-btn');
const ownTag = document.createElement('div');
ownTag.className = 'name-tag';
ownTag.textContent = playerName || 'Kuljettaja';
ownTag.style.display = 'none';
document.body.appendChild(ownTag);
function applyCarColor(hex) {
    bodyMat.color.set(hex);
    car.traverse(c => {
        if (c.isMesh && c.material && c.material.color && !c.material.map) {
            c.material.color.set(hex);
        }
    });
}
window.__apc = (hex) => { carColorHex = hex; applyCarColor(hex); };
if (window.__pName) {
    playerName = window.__pName;
    soloMode = !!window.__solo;
    carColorHex = window.__pColor || '#2b6cc4';
    applyCarColor(carColorHex);
    ownTag.textContent = playerName;
    _canDrive = true;
    document.getElementById('loading').classList.add('hidden');
} else if (!playerName) {
    namePrompt.classList.remove('hidden'); nameInput.focus();
    const submit = () => {
        playerName = nameInput.value.trim() || 'Kuljettaja';
        soloMode = !!window.__solo || !!document.getElementById('solo-check')?.checked;
        namePrompt.classList.add('hidden');
        ownTag.textContent = playerName;
        carColorHex = window.__pColor || '#2b6cc4';
        applyCarColor(carColorHex);
        _canDrive = true;
        document.getElementById('loading').classList.add('hidden');
    };
    nameBtn.addEventListener('click', submit);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
} else namePrompt.classList.add('hidden');


// ── Chat ──
const chatEl = document.getElementById('chat');
const chatMsgsEl = document.getElementById('chat-msgs');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatClose = document.getElementById('chat-close');
const chatReopen = document.getElementById('chat-reopen');
const MAX_CHAT = 20;

function chatAdd(msg) {
    const d = document.createElement('div');
    d.className = 'chat-msg';
    d.innerHTML = msg;
    chatMsgsEl.appendChild(d);
    while (chatMsgsEl.children.length > MAX_CHAT) chatMsgsEl.firstChild.remove();
    chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
}
function chatSendMsg() {
    const t = chatInput.value.trim();
    if (!t) return;
    net.publishChat(t, playerName);
    chatAdd('<span class="name">' + (playerName || 'Kuljettaja') + '</span> ' + t);
    chatInput.value = '';
}
function chatHide() { chatEl.classList.add('hidden'); chatReopen.classList.toggle('hidden', soloMode); }
function chatShow() { if(soloMode) return; chatEl.classList.remove('hidden'); chatReopen.classList.add('hidden'); chatInput.focus(); }
chatSend.addEventListener('click', chatSendMsg);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') chatSendMsg(); });
chatClose?.addEventListener('click', chatHide);
chatReopen?.addEventListener('click', chatShow);
net.setChatHandler(d => { if(soloMode) return; chatAdd('<span class="name">' + (d.n || '??') + '</span> ' + d.t); });

// ════════════════════════════════════════════════════════════
//  MULTIPLAYER — ghost cars of everyone in the shared world
// ════════════════════════════════════════════════════════════
const peers = new Map();   // id -> {group, tx, tz, th, last, color}
const ghostWheelGeo = new THREE.CylinderGeometry(WHEEL_R,WHEEL_R,0.26,10).rotateZ(Math.PI/2);
const ghostWheelMat = new THREE.MeshStandardMaterial({ color:0x141414, roughness:0.85 });
function buildGhost(hex){
    const g=new THREE.Group();
    const m=new THREE.MeshStandardMaterial({ color:hex||0xcccccc, metalness:0.45, roughness:0.4 });
    const low=new THREE.Mesh(new THREE.BoxGeometry(1.86,0.5,4.15), m); low.position.y=0.62; low.castShadow=true; g.add(low);
    const cab=new THREE.Mesh(new THREE.BoxGeometry(1.6,0.48,2.0), m); cab.position.set(0,1.02,-0.15); cab.castShadow=true; g.add(cab);
    const glass=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.42,1.7), new THREE.MeshStandardMaterial({color:0x101820,roughness:0.1})); glass.position.set(0,1.28,-0.15); g.add(glass);
    for(const [wx,wz] of wpos){ const w=new THREE.Mesh(ghostWheelGeo, ghostWheelMat); w.position.set(wx,WHEEL_R,wz); g.add(w); }
    return g;
}
net.setHandlers(
    d=>{  // peer position update
        _seenPeer = true;
        if(soloMode) return;
        let p=peers.get(d.id);
        if(!p){
            const group=buildGhost(d.c); scene.add(group);
            const tag=document.createElement('div'); tag.className='name-tag'; tag.textContent=d.n||'??'; document.body.appendChild(tag);
            p={ group, color:d.c, name:d.n, nameTag:tag }; peers.set(d.id,p);
            group.position.set(d.x, getHeight(d.x,d.z)+RIDE_H, d.z); group.rotation.y=d.h;
            chatAdd('<span class="name">'+(d.n||'??')+'</span> liittyi'); }
        p.tx=d.x; p.tz=d.z; p.th=d.h; p.last=performance.now();
        if(d.n&&d.n!==p.name){ p.name=d.n; if(p.nameTag) p.nameTag.textContent=d.n; }
    },
    id=>{ const p=peers.get(id); if(p){ scene.remove(p.group); if(p.nameTag)p.nameTag.remove(); peers.delete(id);
        chatAdd('<span class="name">'+(p.name||'??')+'</span> poistui'); } }
);
const onlineEl=document.getElementById('online'), onlineN=document.getElementById('online-n');
function updatePeers(dt){
    const now=performance.now(), k=Math.min(1,20*dt);
    for(const [id,p] of peers){
        if(now-(p.last||0) > 6000){ scene.remove(p.group); if(p.nameTag)p.nameTag.remove(); peers.delete(id); continue; }
        const gy=getHeight(p.tx,p.tz)+RIDE_H;
        p.group.position.x += (p.tx-p.group.position.x)*k;
        p.group.position.z += (p.tz-p.group.position.z)*k;
        p.group.position.y += (gy-p.group.position.y)*k;
        let dh=p.th-p.group.rotation.y; while(dh>Math.PI)dh-=6.2832; while(dh<-Math.PI)dh+=6.2832;
        p.group.rotation.y += dh*k;
    }
    if(!soloMode && net.isConnected()){ onlineEl.classList.add('live'); onlineN.textContent=(peers.size+1)+' paikalla'; }
    else { onlineEl.classList.remove('live'); onlineN.textContent='Yksinpeli'; }
}

// ── UI fade ──
setTimeout(()=>{ document.getElementById('hint').classList.add('gone'); document.getElementById('title').classList.add('gone'); }, 6500);

// first/lone player → fresh world (wait a bit for peer messages to arrive)
setTimeout(() => {
    if (!_seenPeer && peers.size === 0) {
        worldEpoch++;
        regenerateWorld(worldEpoch);
    }
}, 2000);
localStorage.setItem('lastPlayed', String(Date.now()));

// ════════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════════
resetCar();
trackOverlay || initTrackOverlay();
roadExtend(pos.x,pos.z);
updateChunks(pos.x,pos.z);   // queue nearby chunks
// Build only the center chunk synchronously so terrain is visible immediately
const ck=Math.round(pos.x/CHUNK)+','+Math.round(pos.z/CHUNK);
if(_chunkBuildQueue.has(ck)){
    const job=_chunkBuildQueue.get(ck);
    _chunkBuildQueue.delete(ck);
    chunks.set(ck, buildChunk(job.x,job.z,job.lod));
}
camPos.set(pos.x, pos.y+6, pos.z-10); camera.position.copy(camPos);

const clock=new THREE.Clock();
function processLodUpgrades(){
    function drain(q,toLod){
        let n=_chunksPerFrame;
        while(n-->0 && q.length){
            const job=q.shift();
            _chunkBuildQueue.set(job.key,{x:job.x,z:job.z,lod:toLod});
        }
    }
    drain(_upgrade21,1);
    drain(_upgrade10,0);
}
function processChunkQueue(){
    let n=_chunksPerFrame;
    while(n-->0 && _chunkBuildQueue.size>0){
        const cx=camChunkX*CHUNK, cz=camChunkZ*CHUNK;
        let bestK=null, bestD=Infinity;
        for(const [k,job] of _chunkBuildQueue){
            const dx=job.x*CHUNK+CHUNK/2-cx, dz=job.z*CHUNK+CHUNK/2-cz;
            const d=dx*dx+dz*dz;
            if(d<bestD){ bestD=d; bestK=k; }
        }
        if(!bestK) break;
        const job=_chunkBuildQueue.get(bestK);
        _chunkBuildQueue.delete(bestK);
        const _old=chunks.get(bestK);
        if(_old){ for(const o of _old.objs){ scene.remove(o); o.geometry?.dispose?.(); } }
        chunks.set(bestK, buildChunk(job.x,job.z,job.lod));
        _upgrading.delete(bestK);
        if(chunks.size>=50) document.getElementById('loading').classList.add('hidden');
    }
}
function animate(){ requestAnimationFrame(animate); update(clock.getDelta()); renderer.render(scene,camera); processLodUpgrades(); processChunkQueue(); }
animate();

setTimeout(()=>document.getElementById('loading').classList.add('hidden'), 400);

addEventListener('resize',()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); });
