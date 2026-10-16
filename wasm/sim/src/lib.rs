//! Apollo 2035 车辆仿真内核（WebAssembly）
//!
//! 与 JS 版 `src/sim/vehicles.worker.js` 的 step()/snapshot() 逐行等价：
//!  - step：按速度沿路线推进位置，走到端点掉头；状态计时器到期后切换状态
//!  - snapshot：二分查找所在线段，插值得到坐标，写成 16 字节/车 的快照记录
//!
//! 不依赖 wasm-bindgen：所有数据都放在 WASM 线性内存里，JS 侧用 TypedArray
//! 视图直接读写（零拷贝），导出函数只传指针和长度。
#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/* ------------------------- 极简堆：线性内存 bump 分配 ------------------------- */
extern "C" {
    static __heap_base: u8;
}
static mut HEAP_TOP: usize = 0;

/// 分配 n 字节（8 字节对齐），返回偏移。内存不足时扩容线性内存。
#[no_mangle]
pub extern "C" fn alloc(n: usize) -> usize {
    unsafe {
        if HEAP_TOP == 0 {
            HEAP_TOP = (&__heap_base as *const u8 as usize + 7) & !7;
        }
        let p = HEAP_TOP;
        let end = (p + n + 7) & !7;
        let have = core::arch::wasm32::memory_size(0) * 65536;
        if end > have {
            let need = (end - have + 65535) / 65536;
            if core::arch::wasm32::memory_grow(0, need) == usize::MAX {
                return 0;
            }
        }
        HEAP_TOP = end;
        p
    }
}

/// 重置分配器（重新装载数据时使用）
#[no_mangle]
pub extern "C" fn reset() {
    unsafe { HEAP_TOP = 0; }
}

/* ------------------------------ 随机数（xorshift） ------------------------------ */
static mut RNG: u32 = 0x9E3779B9;
#[inline]
fn rnd() -> f32 {
    unsafe {
        let mut x = RNG;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        RNG = x;
        (x >> 8) as f32 / 16_777_216.0
    }
}

#[no_mangle]
pub extern "C" fn seed(s: u32) {
    unsafe { RNG = if s == 0 { 0x9E3779B9 } else { s }; }
}

/* ------------------------------ 城市路线表 ------------------------------ */
/// 每个城市的路线数据在 JS 侧拷进 WASM 内存，这里只保存指针。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct City {
    pub starts: u32,   // *const u32  路线 → 顶点起点（routes+1 个）
    pub dists: u32,    // *const f32  路线总长
    pub seg_off: u32,  // *const u32  路线 → 线段起点（routes+1 个）
    pub cum: u32,      // *const f32  线段累计长度
    pub xs: u32,       // *const i32  顶点 x（0.1 MC）
    pub ys: u32,       // *const i32  顶点 y（0.1 MC）
    pub ox: f64,       // 城市原点（图层坐标）
    pub oy: f64,
}

const ST_TRIP: u8 = 2;
const ST_IDLE: u8 = 0;
const ST_PICKUP: u8 = 1;
const ST_CHARGE: u8 = 3;
const MC_PER_M: f32 = 1.25;

#[inline]
unsafe fn rd_u32(p: u32, i: u32) -> u32 { *((p as usize + i as usize * 4) as *const u32) }
#[inline]
unsafe fn rd_f32(p: u32, i: u32) -> f32 { *((p as usize + i as usize * 4) as *const f32) }
#[inline]
unsafe fn rd_i32(p: u32, i: u32) -> i32 { *((p as usize + i as usize * 4) as *const i32) }

/// 推进一步。车辆状态数组均为 SoA，指针由 JS 侧通过 alloc 申请。
/// 返回实际移动的车辆数。
#[no_mangle]
pub unsafe extern "C" fn step(
    n: u32,
    cities: *const City,
    s_city: *const u16,
    s_route: *const i32,
    s_pos: *mut f32,
    s_dir: *mut i8,
    s_speed: *mut f32,
    s_status: *mut u8,
    s_timer: *mut f32,
    s_target: *mut f32,
    dt: f32,
    congestion: f32,
    // 状态转移的累计概率阈值：u < p_trip → 载客；< p_idle → 空驶；< p_pick → 接驾；否则充电
    // 由 JS 按一天中的时刻给出（凌晨载客少、高峰载客多）
    p_trip: f32,
    p_idle: f32,
    p_pick: f32,
) -> u32 {
    let mut moved = 0u32;
    for i in 0..n as usize {
        let t = s_timer.add(i);
        *t -= dt;
        if *t <= 0.0 {
            let u = rnd();
            let st = if u < p_trip { ST_TRIP } else if u < p_idle { ST_IDLE } else if u < p_pick { ST_PICKUP } else { ST_CHARGE };
            *s_status.add(i) = st;
            *t = 30.0 + rnd() * 300.0;
            let f = if st == ST_CHARGE { 0.0 } else if st == ST_TRIP { 1.0 } else { 0.45 };
            *s_target.add(i) = (5.0 + rnd() * 12.0) * f;
        }
        let sp = s_speed.add(i);
        let k = if dt * 0.7 < 1.0 { dt * 0.7 } else { 1.0 };
        *sp += (*s_target.add(i) - *sp) * k;
        let v = *sp * congestion;
        if v <= 0.02 { continue; }
        let c = &*cities.add(*s_city.add(i) as usize);
        let ri = *s_route.add(i) as u32;
        let len = rd_f32(c.dists, ri);
        let len = if len > 0.0 { len } else { 1.0 };
        let d = s_dir.add(i);
        let mut pos = *s_pos.add(i) + (*d as f32) * v * MC_PER_M * dt;
        if pos > len { pos = len - (pos - len); *d = -1; } else if pos < 0.0 { pos = -pos; *d = 1; }
        *s_pos.add(i) = pos;
        moved += 1;
    }
    moved
}

/// 写快照：每车 16 字节 [f32 x, f32 y, f32 angle, u8 speed, u8 state, u8 born, u8 len]
#[no_mangle]
pub unsafe extern "C" fn snapshot(
    n: u32,
    cities: *const City,
    s_city: *const u16,
    s_route: *const i32,
    s_pos: *const f32,
    s_speed: *const f32,
    s_status: *const u8,
    s_born: *mut u8,
    s_len: *const u8,
    out: *mut u8,
) {
    for i in 0..n as usize {
        let c = &*cities.add(*s_city.add(i) as usize);
        let ri = *s_route.add(i) as u32;
        let lo = rd_u32(c.seg_off, ri);
        let hi = rd_u32(c.seg_off, ri + 1);
        let v0 = rd_u32(c.starts, ri);
        let pos = *s_pos.add(i);
        let (ax, ay, bx, by, f);
        if hi <= lo {
            ax = rd_i32(c.xs, v0) as f32; ay = rd_i32(c.ys, v0) as f32;
            bx = ax; by = ay; f = 0.0;
        } else {
            // 二分：第一个 cum[k] >= pos 的线段
            let (mut a, mut b) = (lo, hi);
            while a < b {
                let mid = (a + b) >> 1;
                if rd_f32(c.cum, mid) < pos { a = mid + 1; } else { b = mid; }
            }
            let k = if a >= hi { hi - 1 } else { a };
            let seg_start = if k > lo { rd_f32(c.cum, k - 1) } else { 0.0 };
            let seg_len = { let l = rd_f32(c.cum, k) - seg_start; if l > 0.001 { l } else { 0.001 } };
            let vi = v0 + (k - lo);
            ax = rd_i32(c.xs, vi) as f32; ay = rd_i32(c.ys, vi) as f32;
            bx = rd_i32(c.xs, vi + 1) as f32; by = rd_i32(c.ys, vi + 1) as f32;
            let ff = (pos - seg_start) / seg_len;
            f = if ff < 0.0 { 0.0 } else if ff > 1.0 { 1.0 } else { ff };
        }
        let x = c.ox + ((ax + (bx - ax) * f) / 10.0) as f64;
        let y = c.oy + ((ay + (by - ay) * f) / 10.0) as f64;
        let o = out.add(i * 16);
        *(o as *mut f32) = x as f32;
        *(o.add(4) as *mut f32) = y as f32;
        *(o.add(8) as *mut f32) = atan2(by - ay, bx - ax);
        let spd = *s_speed.add(i) * 3.6;
        *o.add(12) = if spd > 255.0 { 255 } else if spd < 0.0 { 0 } else { spd as u8 };
        *o.add(13) = *s_status.add(i);
        *o.add(14) = *s_born.add(i);
        *o.add(15) = *s_len.add(i);
        *s_born.add(i) = 0;
    }
}

/// no_std 下没有 libm，手写 atan2（最大误差约 0.005 rad，用于车头朝向足够）
#[inline]
fn atan2(y: f32, x: f32) -> f32 {
    const PI: f32 = core::f32::consts::PI;
    const HALF_PI: f32 = core::f32::consts::FRAC_PI_2;
    if x == 0.0 && y == 0.0 { return 0.0; }
    let ax = if x < 0.0 { -x } else { x };
    let ay = if y < 0.0 { -y } else { y };
    let (mn, mx) = if ax < ay { (ax, ay) } else { (ay, ax) };
    let a = mn / mx;
    let s = a * a;
    let mut r = ((-0.046_496_474_9 * s + 0.159_314_22) * s - 0.327_622_764) * s * a + a;
    if ay > ax { r = HALF_PI - r; }
    if x < 0.0 { r = PI - r; }
    if y < 0.0 { r = -r; }
    r
}
