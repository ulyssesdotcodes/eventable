import * as THREE from "three/webgpu"

// Ported from threely and trimmed to the curl chain — the simplex/psrdnoise
// helpers were dead and were removed. This is opaque WGSL wrapped in wgslFn()
// calls; @types/three types the dependency-array form far more strictly than
// the runtime accepts, and the shader source is the real contract here, so the
// wgslFn binding is deliberately untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wgslFn: any = THREE.TSL.wgslFn

const permute289v4f = wgslFn(`
fn permute289v4f(i: vec4<f32>) -> vec4<f32>
{
	var im: vec4<f32> = i - floor(i / 289.0) * 289.0;
	var i2 = (im*34.0 + 10.0)*im;
	return i2 - floor(i2 / 289.0) * 289.0;
;
}
`)


const srdnoise3 = wgslFn(`
fn srdnoise3(x: vec3<f32>, alpha: f32) -> vec3<f32>
{
	let M = mat3x3<f32>(0.0, 1.0, 1.0, 1.0, 0.0, 1.0,  1.0, 1.0, 0.0);
	let Mi = mat3x3<f32>(-0.5, 0.5, 0.5, 0.5,-0.5, 0.5, 0.5, 0.5,-0.5);

	var uvw: vec3<f32>;
	var i0: vec3<f32>;
	var i1: vec3<f32>;
	var i2: vec3<f32>;
	var i3: vec3<f32>;
	var f0: vec3<f32>;
	var gt_: vec3<f32>;
	var lt_: vec3<f32>;
	var gt: vec3<f32>;
	var lt: vec3<f32>;
	var o1: vec3<f32>;
	var o2: vec3<f32>;
	var v0: vec3<f32>;
	var v1: vec3<f32>;
	var v2: vec3<f32>;
	var v3: vec3<f32>;
	var x0: vec3<f32>;
	var x1: vec3<f32>;
	var x2: vec3<f32>;
	var x3: vec3<f32>;
	
	uvw = M * x;
	i0 = floor(uvw);
	f0 = uvw - i0;
	gt_ = step(f0.xyx, f0.yzz);
	lt_ = 1.0 - gt_;
	gt = vec3<f32>(lt_.z, gt_.xy);
	lt = vec3<f32>(lt_.xy, gt_.z);
	o1 = min( gt, lt );
	o2 = max( gt, lt );
	i1 = i0 + o1;
	i2 = i0 + o2;
	i3 = i0 + vec3<f32>(1.0,1.0,1.0);
	v0 = Mi * i0;
	v1 = Mi * i1;
	v2 = Mi * i2;
	v3 = Mi * i3;
	x0 = x - v0;
	x1 = x - v1;
	x2 = x - v2;
	x3 = x - v3;
		
	var hash: vec4<f32>;
	var theta: vec4<f32>;
	var sz: vec4<f32>;
	var psi: vec4<f32>;
	var St: vec4<f32>;
	var Ct: vec4<f32>;
	var sz_: vec4<f32>;

	hash = permute289v4f( permute289v4f( permute289v4f( 
		vec4<f32>(i0.z, i1.z, i2.z, i3.z ))
		+ vec4<f32>(i0.y, i1.y, i2.y, i3.y ))
		+ vec4<f32>(i0.x, i1.x, i2.x, i3.x ));
	theta = hash * 3.883222077;
	sz = hash * -0.006920415 + 0.996539792;
	psi = hash * 0.108705628;
	Ct = cos(theta);
	St = sin(theta);
	sz_ = sqrt( 1.0 - sz*sz );

	var gx: vec4<f32>;
	var gy: vec4<f32>;
	var gz: vec4<f32>;
	var px: vec4<f32>;
	var py: vec4<f32>;
	var pz: vec4<f32>;
	var Sp: vec4<f32>;
	var Cp: vec4<f32>;
	var Ctp: vec4<f32>;
	var qx: vec4<f32>;
	var qy: vec4<f32>;
	var qz: vec4<f32>;
	var Sa: vec4<f32>;
	var Ca: vec4<f32>;

	if(alpha != 0.0)
	{
		px = Ct * sz_;
		py = St * sz_;
		pz = sz;
		Sp = sin(psi);
		Cp = cos(psi);
		Ctp = St*Sp - Ct*Cp;
		qx = mix( Ctp*St, Sp, sz);
		qy = mix(-Ctp*Ct, Cp, sz);
		qz = -(py*Cp + px*Sp);
		Sa = vec4<f32>(sin(alpha));
		Ca = vec4<f32>(cos(alpha));
		gx = Ca*px + Sa*qx;
		gy = Ca*py + Sa*qy;
		gz = Ca*pz + Sa*qz;
	}
	else
	{
		gx = Ct * sz_;
		gy = St * sz_;
		gz = sz;  
	}
	
	var g0: vec3<f32>;
	var g1: vec3<f32>;
	var g2: vec3<f32>;
	var g3: vec3<f32>;
	var w: vec4<f32>;
	var w2: vec4<f32>;
	var w3: vec4<f32>;
	var gdotx: vec4<f32>;
	
	g0 = vec3<f32>(gx.x, gy.x, gz.x);
	g1 = vec3<f32>(gx.y, gy.y, gz.y);
	g2 = vec3<f32>(gx.z, gy.z, gz.z);
	g3 = vec3<f32>(gx.w, gy.w, gz.w);
	w = 0.5 - vec4<f32>(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3));
	w = max(w, vec4<f32>(0.0, 0.0, 0.0, 0.0));
	w2 = w * w;
	w3 = w2 * w;
	gdotx = vec4<f32>(dot(g0,x0), dot(g1,x1), dot(g2,x2), dot(g3,x3));

	var dw: vec4<f32> = -6.0 * w2 * gdotx;
	var dn0: vec3<f32> = w3.x * g0 + dw.x * x0;
	var dn1: vec3<f32> = w3.y * g1 + dw.y * x1;
	var dn2: vec3<f32> = w3.z * g2 + dw.z * x2;
	var dn3: vec3<f32> = w3.w * g3 + dw.w * x3;
	var g: vec3<f32> = 39.5 * (dn0 + dn1 + dn2 + dn3);
	
	return g;
}
`, [permute289v4f])


const octaves = wgslFn(`
fn octaves(pos: vec3<f32>, time: f32) -> vec3<f32>{
  return srdnoise3(pos, time) + srdnoise3(pos / 2, time / 2) + srdnoise3(pos / 4, time / 4);
}
`, [srdnoise3])


const level = wgslFn(`
fn level(posa: vec3<f32>, elscale: f32, time: f32, speed: f32, force: vec3<f32>) -> vec3<f32> {

var pos = posa;

var delta = 0.0001;
var dy = octaves(pos + 17, time);
var dz = octaves(pos - 42, time);


var curl = vec3(
  (dy.z - dz.y) / (2 * delta), 
  (dy.x - dz.z) / (2 * delta), 
  (dy.y - dz.x) / (2 * delta)
);

    
return force +  (normalize(curl) * (speed / elscale));
}
`, [octaves])


export const curl = wgslFn(`
fn curl(index: f32, posa: vec3<f32>, elscale: f32, time: f32, speed: f32, force: vec3<f32>, ) -> vec3<f32> {

 var uv = vec2(index + 22, index + 84);
  var dt = dot(uv.xy, vec2(12.9898, 78.233));
  var sn = dt % 3.141592653589793;
  var newspeed = fract(sin(sn) * 43758.5453);

newspeed = (newspeed * 0.05 + 0.95) * speed;

return level(posa, elscale, time, newspeed, force);
}
`, [level])
