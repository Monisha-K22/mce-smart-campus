const express = require('express');
const bcrypt  = require('bcrypt');
const db      = require('./db');
const router  = express.Router();

function requireAuth(req,res,next){
  if(req.session?.user) return next();
  return res.status(401).json({error:'Not authenticated'});
}
function dayFromStr(s){
  const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const [y,m,d]=s.split('-').map(Number);
  return DAYS[new Date(Date.UTC(y,m-1,d)).getUTCDay()];
}
function toMins(t){const[h,m]=(t||'0:0').split(':').map(Number);return h*60+m;}

// ── AUTH ─────────────────────────────────────────────────────
router.post('/register',async(req,res)=>{
  const{name,email,password,role,department,roll_no}=req.body;
  if(!name||!email||!password) return res.status(400).json({error:'Name, email and password required.'});
  try{
    const[ex]=await db.query('SELECT id FROM users WHERE email=?',[email]);
    if(ex.length) return res.status(409).json({error:'Email already registered.'});
    const hash=await bcrypt.hash(password,10);
    const[r]=await db.query(
      'INSERT INTO users(name,email,password,role,department,roll_no) VALUES(?,?,?,?,?,?)',
      [name,email,hash,role||'student',department||null,roll_no||null]);
    res.json({success:true,userId:r.insertId});
  }catch(e){console.error(e);res.status(500).json({error:'Registration error.'});}
});

router.post('/login',async(req,res)=>{
  const{email,password}=req.body;
  if(!email||!password) return res.status(400).json({error:'Email and password required.'});
  try{
    const[rows]=await db.query('SELECT * FROM users WHERE email=?',[email]);
    if(!rows.length) return res.status(401).json({error:'Invalid email or password.'});
    const user=rows[0];
    if(!await bcrypt.compare(password,user.password)) return res.status(401).json({error:'Invalid email or password.'});
    req.session.user={id:user.id,name:user.name,email:user.email,role:user.role};
    res.json({success:true,user:req.session.user});
  }catch(e){console.error(e);res.status(500).json({error:'Login error.'});}
});

router.post('/logout',(req,res)=>{req.session.destroy(()=>res.json({success:true}));});
router.get('/me',(req,res)=>{
  if(req.session?.user) return res.json({user:req.session.user});
  res.status(401).json({error:'Not authenticated'});
});

// ── FACILITIES ───────────────────────────────────────────────
router.get('/facilities',async(req,res)=>{
  try{
    const[rows]=await db.query('SELECT * FROM facilities WHERE is_active=1 ORDER BY id');
    res.json(rows);
  }catch(e){res.status(500).json({error:'Could not fetch facilities.'});}
});

// ── SCHEDULE ─────────────────────────────────────────────────
router.get('/schedule',async(req,res)=>{
  const day=req.query.day||'Mon';
  try{
    const[rows]=await db.query(
      `SELECT t.*,f.name AS facility_name,f.capacity
       FROM timetable t JOIN facilities f ON t.facility_id=f.id
       WHERE t.day_of_week=? ORDER BY t.slot_start,f.name`,[day]);
    res.json(rows);
  }catch(e){res.status(500).json({error:'Could not fetch schedule.'});}
});

// ── AVAILABILITY ─────────────────────────────────────────────
// Returns timetable[] locked slots + bookings[] with is_mine flag
router.get('/availability',async(req,res)=>{
  const{facility_id,date}=req.query;
  if(!facility_id||!date) return res.status(400).json({error:'facility_id and date required.'});
  try{
    const dayName=dayFromStr(date);
    const todayStr=new Date().toLocaleDateString('en-CA');
    const isToday=(date===todayStr);
    const nowMins=isToday?new Date().getHours()*60+new Date().getMinutes():-1;
    const userId=req.session?.user?.id||null;

    console.log(`[avail] fid=${facility_id} date=${date} day=${dayName} isToday=${isToday} nowMins=${nowMins}`);

    // 1) Timetable
    const[ttRows]=await db.query(
      `SELECT slot_start,slot_end,subject_code,subject_name,faculty,section,venue_note
       FROM timetable WHERE facility_id=? AND day_of_week=?`,[facility_id,dayName]);

    console.log(`[avail] timetable rows: ${ttRows.length}`);

    // Filter out expired timetable slots (auto-release)
    const timetable=ttRows
      .filter(r=>!isToday||nowMins<toMins(r.slot_end))
      .map(r=>({
        slot_start:r.slot_start, slot_end:r.slot_end,
        subject_code:r.subject_code, subject_name:r.subject_name,
        faculty:r.faculty, section:r.section, venue_note:r.venue_note
      }));

    // 2) Bookings — include booking_id and is_mine flag
    const[bkRows]=await db.query(
      `SELECT b.id AS booking_id, b.slot_start, b.slot_end, b.purpose, b.status, b.user_id,
              u.name AS booked_by
       FROM bookings b JOIN users u ON b.user_id=u.id
       WHERE b.facility_id=? AND b.booking_date=? AND b.status IN ('confirmed','pending')`,
      [facility_id,date]);

    // Filter expired bookings (auto-release)
    const bookings=bkRows
      .filter(r=>!isToday||nowMins<toMins(r.slot_end))
      .map(r=>({
        booking_id:r.booking_id,
        slot_start:r.slot_start, slot_end:r.slot_end,
        purpose:r.purpose, booked_by:r.booked_by,
        status:r.status,
        is_mine: userId!==null && r.user_id===userId
      }));

    res.json({timetable,bookings,day:dayName});
  }catch(e){
    console.error(e);
    res.status(500).json({error:'Could not check availability.'});
  }
});

// ── BOOKINGS: CREATE ─────────────────────────────────────────
router.post('/bookings',requireAuth,async(req,res)=>{
  const{facility_id,booking_date,slot_start,slot_end,purpose}=req.body;
  if(!facility_id||!booking_date||!slot_start||!slot_end)
    return res.status(400).json({error:'All booking fields required.'});
  // Block lunch
  if(slot_start==='13:00:00'||slot_start==='13:00')
    return res.status(400).json({error:'13:00–14:00 is Lunch Break — not bookable.'});
  try{
    const dayName=dayFromStr(booking_date);
    const todayStr=new Date().toLocaleDateString('en-CA');
    const isToday=(booking_date===todayStr);
    const nowMins=isToday?new Date().getHours()*60+new Date().getMinutes():-1;

    // Check timetable conflict (with auto-release)
    const[ttConf]=await db.query(
      `SELECT id,slot_end FROM timetable
       WHERE facility_id=? AND day_of_week=?
         AND NOT(slot_end<=? OR slot_start>=?)`,[facility_id,dayName,slot_start,slot_end]);
    const activeTT=ttConf.filter(r=>!isToday||nowMins<toMins(r.slot_end));
    if(activeTT.length) return res.status(409).json({error:'This slot is locked — official timetable class is scheduled.'});

    // Check booking conflict
    const[bkConf]=await db.query(
      `SELECT id FROM bookings
       WHERE facility_id=? AND booking_date=? AND status='confirmed'
         AND NOT(slot_end<=? OR slot_start>=?)`,[facility_id,booking_date,slot_start,slot_end]);
    if(bkConf.length) return res.status(409).json({error:'This slot is already booked by someone else.'});

    // Block admin from booking
    if(req.session.user.role==='admin')
      return res.status(403).json({error:'Admins cannot book facilities.'});

    const[result]=await db.query(
      'INSERT INTO bookings(user_id,facility_id,booking_date,slot_start,slot_end,purpose,status) VALUES(?,?,?,?,?,?,?)',
      [req.session.user.id,facility_id,booking_date,slot_start,slot_end,purpose||'','pending']);
    res.json({success:true,bookingId:result.insertId,message:'Booking submitted — awaiting admin approval.',status:'pending'});
  }catch(e){console.error(e);res.status(500).json({error:'Server error creating booking.'});}
});

// ── BOOKINGS: AUTO-EXPIRE (system-wide, called on refresh) ───────────────
// Marks ALL confirmed bookings whose time slot has passed as 'cancelled'
router.post('/bookings/auto-expire',async(req,res)=>{
  try{
    const todayStr=new Date().toLocaleDateString('en-CA');
    const nowMins=new Date().getHours()*60+new Date().getMinutes();
    const[result]=await db.query(
      `UPDATE bookings SET status='cancelled'
       WHERE status IN ('confirmed','pending')
         AND (
           booking_date < ?
           OR (booking_date = ? AND TIME_TO_SEC(slot_end)/60 <= ?)
         )`,
      [todayStr,todayStr,nowMins]);
    res.json({success:true,expired:result.affectedRows});
  }catch(e){
    console.error(e);
    res.status(500).json({error:'Auto-expire failed.'});
  }
});

// ── BOOKINGS: MINE ───────────────────────────────────────────
router.get('/bookings/mine',requireAuth,async(req,res)=>{
  try{
    // Auto-cancel expired bookings for this user before returning list
    const todayStr=new Date().toLocaleDateString('en-CA');
    const nowMins=new Date().getHours()*60+new Date().getMinutes();
    await db.query(
      `UPDATE bookings SET status='cancelled'
       WHERE user_id=? AND status IN ('confirmed','pending')
         AND (
           booking_date < ?
           OR (booking_date = ? AND TIME_TO_SEC(slot_end)/60 <= ?)
         )`,
      [req.session.user.id,todayStr,todayStr,nowMins]);
    const[rows]=await db.query(
      `SELECT
  b.id,
  b.user_id,
  b.facility_id,
  DATE_FORMAT(b.booking_date,'%Y-%m-%d') AS booking_date,
  b.slot_start,
  b.slot_end,
  b.purpose,
  b.status,
  b.created_at,
  f.name AS facility_name,
  f.icon,
  f.capacity
       FROM bookings b JOIN facilities f ON b.facility_id=f.id
       WHERE b.user_id=?
       ORDER BY
         CASE WHEN b.status IN ('confirmed','pending') THEN 0 ELSE 1 END ASC,
         b.booking_date DESC,
         b.slot_start ASC`,
      [req.session.user.id]);
    res.json(rows);
  }catch(e){res.status(500).json({error:'Could not fetch bookings.'});}
});

// ── BOOKINGS: CANCEL ─────────────────────────────────────────
router.patch('/bookings/:id/cancel',requireAuth,async(req,res)=>{
  try{
    const[rows]=await db.query('SELECT * FROM bookings WHERE id=?',[req.params.id]);
    if(!rows.length) return res.status(404).json({error:'Booking not found.'});
    if(rows[0].user_id!==req.session.user.id&&req.session.user.role!=='admin')
      return res.status(403).json({error:'Not authorised.'});
    await db.query("UPDATE bookings SET status='cancelled' WHERE id=?",[req.params.id]);
    res.json({success:true,message:'Booking cancelled.'});
  }catch(e){res.status(500).json({error:'Could not cancel booking.'});}
});

// ── ADMIN ────────────────────────────────────────────────────
router.get('/admin/bookings',requireAuth,async(req,res)=>{
  if(req.session.user.role!=='admin') return res.status(403).json({error:'Admin only.'});
  try{
    const[rows]=await db.query(
      `SELECT b.*,u.name AS user_name,u.email AS user_email,u.role AS user_role,f.name AS facility_name
       FROM bookings b JOIN users u ON b.user_id=u.id JOIN facilities f ON b.facility_id=f.id
       ORDER BY
         CASE WHEN b.status='pending' THEN 0 WHEN b.status='confirmed' THEN 1 ELSE 2 END ASC,
         b.created_at DESC`);
    res.json(rows);
  }catch(e){res.status(500).json({error:'Could not fetch bookings.'});}
});

// ── ADMIN: APPROVE BOOKING ───────────────────────────────────
router.put('/admin/bookings/:id/approve',requireAuth,async(req,res)=>{
  if(req.session.user.role!=='admin') return res.status(403).json({error:'Admin only.'});
  try{
    await db.query("UPDATE bookings SET status='confirmed' WHERE id=?",[req.params.id]);
    res.json({success:true,message:'Booking approved.'});
  }catch(e){res.status(500).json({error:'Could not approve booking.'});}
});

// ── ADMIN: REJECT BOOKING ────────────────────────────────────
router.put('/admin/bookings/:id/reject',requireAuth,async(req,res)=>{
  if(req.session.user.role!=='admin') return res.status(403).json({error:'Admin only.'});
  try{
    await db.query("UPDATE bookings SET status='cancelled' WHERE id=?",[req.params.id]);
    res.json({success:true,message:'Booking rejected.'});
  }catch(e){res.status(500).json({error:'Could not reject booking.'});}
});

// ── ADMIN: GET ALL USERS ─────────────────────────────────────
router.get('/admin/users',requireAuth,async(req,res)=>{
  if(req.session.user.role!=='admin') return res.status(403).json({error:'Admin only.'});
  try{
    const[rows]=await db.query(
      'SELECT id,name,email,role,department,roll_no,created_at FROM users ORDER BY created_at DESC');
    res.json(rows);
  }catch(e){res.status(500).json({error:'Could not fetch users.'});}
});

// ── ADMIN: DELETE USER ───────────────────────────────────────
router.delete('/admin/users/:id',requireAuth,async(req,res)=>{
  if(req.session.user.role!=='admin') return res.status(403).json({error:'Admin only.'});
  if(parseInt(req.params.id)===req.session.user.id)
    return res.status(400).json({error:'Cannot delete your own account.'});
  try{
    await db.query('DELETE FROM users WHERE id=?',[req.params.id]);
    res.json({success:true,message:'User deleted.'});
  }catch(e){res.status(500).json({error:'Could not delete user.'});}
});

module.exports=router;
