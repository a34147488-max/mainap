import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';

let renderer, scene, camera, raf, resizeObserver, actors=[], running=false, last=0, arenaEl;
const clock = new THREE.Clock();
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

function material(color, roughness=.55, metalness=.08, emissive=0, emissiveIntensity=0){
 return new THREE.MeshStandardMaterial({color,roughness,metalness,emissive,emissiveIntensity});
}
function limb(parent, a, b, radius, mat){
 const start=new THREE.Vector3(...a), end=new THREE.Vector3(...b), delta=end.clone().sub(start);
 const mesh=new THREE.Mesh(new THREE.CapsuleGeometry(radius,Math.max(.01,delta.length()-radius*2),4,8),mat);
 mesh.position.copy(start).add(end).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());parent.add(mesh);return mesh;
}
function sphere(parent,pos,scale,mat,geometry){
 const m=new THREE.Mesh(geometry||new THREE.SphereGeometry(1,16,12),mat);m.position.set(...pos);m.scale.set(...scale);parent.add(m);return m;
}
function makeFighter(kind){
 const scorp=kind==='scorpion', root=new THREE.Group();
 const skin=material(scorp?0x8d3428:0x9dc6d9,.44,.1), cloth=material(scorp?0x21121b:0x142a47,.68,.05), armor=material(scorp?0x17151c:0x4cc3e8,.28,.5,scorp?0x6e1008:0x075a91,.35), trim=material(scorp?0xf04a17:0x8df3ff,.25,.45,scorp?0xff2600:0x27bfff,1.3), mask=material(scorp?0xd3a344:0xb7e8f4,.32,.5), black=material(0x080b14,.65,.05);
 const torso=new THREE.Group();root.add(torso);
 sphere(torso,[0,1.45,0],[.43,.57,.25],cloth);
 sphere(torso,[0,1.49,.02],[.38,.45,.27],armor);
 sphere(torso,[0,1.5,.245],[.22,.34,.035],trim);
 sphere(torso,[0,1.91,0],[.29,.23,.26],skin);
 sphere(torso,[0,1.98,.12],[.27,.20,.23],mask);
 sphere(torso,[0,1.93,.322],[.20,.07,.035],black);
 for(const x of [-.11,.11]) sphere(torso,[x,1.94,.355],[.035,.025,.012],trim);
 // shoulder armor, upper/lower arms and fists are independently articulated groups
 const arms=[];
 for(const side of [-1,1]){
  const arm=new THREE.Group();arm.position.set(side*.39,1.78,0);torso.add(arm);
  sphere(arm,[side*.12,-.03,0],[.20,.20,.22],armor);
  limb(arm,[0,-.06,0],[side*.12,-.38,.03],.105,cloth);
  sphere(arm,[side*.12,-.38,.03],[.115,.12,.12],skin);
  limb(arm,[side*.12,-.38,.03],[side*.16,-.68,.14],.085,armor);
  sphere(arm,[side*.16,-.73,.16],[.12,.12,.12],mask);
  sphere(arm,[side*.16,-.73,.245],[.09,.08,.04],trim);
  arms.push({group:arm,side});
 }
 const legs=[];
 for(const side of [-1,1]){
  const leg=new THREE.Group();leg.position.set(side*.21,1.02,0);root.add(leg);
  limb(leg,[0,0,0],[side*.025,-.42,.015],.15,cloth);
  sphere(leg,[side*.025,-.42,.015],[.15,.16,.15],armor);
  limb(leg,[side*.025,-.42,.015],[side*.035,-.83,.09],.115,cloth);
  sphere(leg,[side*.035,-.88,.18],[.16,.10,.25],black);
  sphere(leg,[side*.035,-.33,.12],[.15,.18,.055],trim);
  legs.push({group:leg,side});
 }
 // ninja hood and back cloth
 sphere(torso,[0,2.10,-.03],[.31,.29,.28],cloth);
 const cape=new THREE.Mesh(new THREE.ConeGeometry(.28,.72,5),cloth);cape.position.set(0,1.15,-.22);cape.rotation.x=-.12;root.add(cape);
 if(scorp){
  const blade=new THREE.Mesh(new THREE.ConeGeometry(.045,.9,8),trim);blade.position.set(.53,1.35,-.06);blade.rotation.z=-.75;root.add(blade);
  for(let i=0;i<3;i++){const spike=new THREE.Mesh(new THREE.ConeGeometry(.035,.22,6),trim);spike.position.set(-.2+i*.2,1.15,-.25);spike.rotation.x=-1.2;root.add(spike)}
 }else{
  for(let i=0;i<3;i++){const shard=new THREE.Mesh(new THREE.ConeGeometry(.06,.4,5),trim);shard.position.set(-.3+i*.3,1.2,-.2);shard.rotation.x=-.8;root.add(shard)}
 }
 root.scale.setScalar(1.03);
 return {root,torso,arms,legs,kind,phase:Math.random()*6,vel:new THREE.Vector3(),health:100,hit:0,attack:0,attackCooldown:1+Math.random(),groundY:0};
}
function buildArena(){
 scene=new THREE.Scene();scene.background=new THREE.Color(0x19050c);scene.fog=new THREE.Fog(0x26070b,10,27);
 camera=new THREE.PerspectiveCamera(38,1,.1,100);camera.position.set(0,4.6,11.8);camera.lookAt(0,1.2,0);
 scene.add(new THREE.HemisphereLight(0xffd7c0,0x190b22,2.1));
 const key=new THREE.DirectionalLight(0xffd0a0,3.3);key.position.set(-4,8,5);scene.add(key);
 const red=new THREE.PointLight(0xff2608,45,14);red.position.set(0,2.5,-3);scene.add(red);
 const blue=new THREE.PointLight(0x36aaff,24,8);blue.position.set(-4,3,2);scene.add(blue);
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(30,24),material(0x21141b,.9));ground.rotation.x=-Math.PI/2;ground.position.y=-.06;scene.add(ground);
 const platform=new THREE.Mesh(new THREE.CylinderGeometry(5.8,6.4,.28,8),material(0x261b23,.65,.35));platform.position.y=.04;scene.add(platform);
 const ring=new THREE.Mesh(new THREE.TorusGeometry(5.2,.055,8,100),material(0xff4b17,.25,.4,0xff2100,2));ring.rotation.x=Math.PI/2;ring.position.y=.2;scene.add(ring);
 // volcano silhouette and glowing lava falls behind the fighters
 const mountainMat=material(0x260b15,.95,0,0x5c0905,.4);
 for(let i=0;i<7;i++){const h=2.5+(i%3)*.75,m=new THREE.Mesh(new THREE.ConeGeometry(1.2+(i%2)*.5,h,5),mountainMat);m.position.set((i-3)*1.9,h/2-0.1,-5.5);scene.add(m)}
 for(let i=0;i<16;i++){const lava=new THREE.Mesh(new THREE.BoxGeometry(.035,1.2+Math.random()*2,.04),material(0xff4b10,.3,.2,0xff2600,3));lava.position.set((Math.random()-.5)*12,.4+Math.random()*1.5,-4.9);scene.add(lava)}
 for(let i=0;i<55;i++){const ember=new THREE.Mesh(new THREE.SphereGeometry(.025+Math.random()*.035,6,5),material(0xff6a20,.3,0,0xff3b00,2));ember.position.set((Math.random()-.5)*12,Math.random()*5-0.1,-2-Math.random()*5);ember.userData.float=Math.random()*4;scene.add(ember);embers.push(ember)}
 actors=[makeFighter('subzero'),makeFighter('scorpion')];
 actors[0].root.position.set(-2.2,0,0);actors[0].root.rotation.y=.2;
 actors[1].root.position.set(2.2,0,0);actors[1].root.rotation.y=Math.PI-.2;
 scene.add(actors[0].root,actors[1].root);
}
const embers=[];
function setupRenderer(){
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.7));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;
 renderer.domElement.style.cssText='position:absolute;inset:0;width:100%;height:100%;display:block;z-index:6;touch-action:pan-y';
 arenaEl.appendChild(renderer.domElement);
 resizeObserver=new ResizeObserver(resize);resizeObserver.observe(arenaEl);resize();
}
function resize(){if(!renderer||!arenaEl)return;const w=Math.max(1,arenaEl.clientWidth),h=Math.max(1,arenaEl.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix()}
function hitActor(a,side){
 a.health=Math.max(0,a.health-(4+Math.random()*7));a.hit=.32;a.vel.x=side*2.8;a.vel.y=1.6;
 const other=actors.find(x=>x!==a);other.attack=.42;
 const hpId=a.kind==='subzero'?'mkSubHp':'mkScorpHp',txtId=a.kind==='subzero'?'mkSubHpText':'mkScorpHpText';
 const bar=document.getElementById(hpId),txt=document.getElementById(txtId);
 if(bar)bar.style.width=a.health+'%';if(txt)txt.textContent=Math.round(a.health)+'%';
 const arena=document.getElementById('mkArena');if(arena){arena.classList.remove('fight');void arena.offsetWidth;arena.classList.add('fight')}
}
function animate(now){
 if(!running||!renderer)return;raf=requestAnimationFrame(animate);
 const dt=Math.min(.035,(now-last)/1000||.016);last=now;const t=clock.getElapsedTime();
 for(const a of actors){
  a.phase+=dt*4;a.attackCooldown-=dt;a.hit=Math.max(0,a.hit-dt);a.attack=Math.max(0,a.attack-dt);
  a.root.position.x+=a.vel.x*dt;a.root.position.y+=a.vel.y*dt;a.vel.y-=9.8*dt;
  if(a.root.position.y<0){a.root.position.y=0;a.vel.y=0;a.vel.x*=Math.pow(.06,dt)}
  a.root.position.x=clamp(a.root.position.x,-3.5,3.5);
  a.torso.rotation.z=(a.hit>0?-.35:0)+Math.sin(a.phase)*.025;
  a.legs.forEach((l,i)=>{l.group.rotation.x=a.attack>0?(i===0?-.85:.35):Math.sin(a.phase+(i*Math.PI))*.12});
  a.arms.forEach((arm,i)=>{arm.group.rotation.x=a.attack>0?(i===0?-1.35:.35):Math.sin(a.phase+i)*.08;arm.group.rotation.z=a.attack>0?arm.side*(i===0?-.75:.2):arm.side*(.05+Math.sin(a.phase+i)*.05)});
  if(a.attackCooldown<=0&&a.hit<=0){
   a.attackCooldown=.8+Math.random()*1.4;
   const victim=actors.find(x=>x!==a);
   if(Math.abs(a.root.position.x-victim.root.position.x)<3.8&&Math.random()>.15){a.attack=.32;setTimeout(()=>{if(running&&victim.health>0)hitActor(victim,a.root.position.x<victim.root.position.x?1:-1)},170)}
  }
 }
 for(const e of embers){e.position.y+=Math.sin(t+e.userData.float)*dt*.3;if(e.position.y>5.5)e.position.y=-.2}
 renderer.render(scene,camera);
}
export function startMortal3D(){
 stopMortal3D();arenaEl=document.getElementById('mkArena');if(!arenaEl)return;
 try{embers.length=0;buildArena();setupRenderer();arenaEl.querySelectorAll('.mk-vs,.mk-fighter,.mk-ice,.mk-fire,.mk-flash,.impact-flash,.volcano-sky,.volcano-mountain,.lava-river,.lava-crack').forEach(el=>el.style.display='none');running=true;last=0;raf=requestAnimationFrame(animate)}
 catch(e){console.error('3D arena init failed',e);stopMortal3D();if(arenaEl)arenaEl.insertAdjacentHTML('beforeend','<div style="position:absolute;inset:0;display:grid;place-items:center;background:#18050b;color:#fff;padding:18px;text-align:center;z-index:8">3D-сцена недоступна в этом браузере. Обнови страницу или отключи энергосбережение.</div>')}
}
export function stopMortal3D(){running=false;if(raf)cancelAnimationFrame(raf);raf=null;if(resizeObserver)resizeObserver.disconnect();resizeObserver=null;if(renderer){renderer.dispose();renderer.domElement.remove();renderer=null}if(scene){scene.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material){if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material.dispose()}})}scene=null;camera=null;actors=[];embers.length=0}
window.startMortal3D=startMortal3D;window.stopMortal3D=stopMortal3D;
