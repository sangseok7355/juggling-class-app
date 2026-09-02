const STORAGE_KEY = 'juggling_students_v3';
const { auth, db } = window.firebaseServices;

function makeStudentEmail(studentInfo) {
  const clean = value => String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return `student.${clean(studentInfo.classCode)}.${clean(studentInfo.grade)}.${clean(studentInfo.classNum)}.${clean(studentInfo.number)}@juggling.local`;
}

async function ensureStudentAuth(studentInfo) {
  const email = makeStudentEmail(studentInfo);
  if (auth.currentUser?.email === email) return auth.currentUser;
  if (auth.currentUser) await auth.signOut();
  try {
    return (await auth.signInWithEmailAndPassword(email, studentInfo.pin)).user;
  } catch (signInError) {
    try {
      return (await auth.createUserWithEmailAndPassword(email, studentInfo.pin)).user;
    } catch (createError) {
      if (createError.code === 'auth/email-already-in-use') {
        throw new Error('개인 PIN이 일치하지 않습니다. 처음 등록할 때 입력한 PIN 6자리를 확인해주세요.');
      }
      throw createError;
    }
  }
}

async function getOrCreateStudent(studentInfo) {
  const user = await ensureStudentAuth(studentInfo);
  const classCode = studentInfo.classCode.trim().toUpperCase();
  const codeSnapshot = await db.collection('classCodes').doc(classCode).get();
  if (!codeSnapshot.exists) throw new Error('학급 코드를 확인해주세요.');
  const classInfo = codeSnapshot.data();
  const ref = db.collection('teachers').doc(classInfo.teacherUid).collection('classes').doc(classInfo.classId).collection('students').doc(user.uid);
  const snapshot = await ref.get();
  if (snapshot.exists) return snapshot.data();
  const student = {
    studentId: user.uid, authUid: user.uid, teacherUid: classInfo.teacherUid,
    classId: classInfo.classId, classCode,
    grade: studentInfo.grade, classNum: studentInfo.classNum,
    number: studentInfo.number, name: studentInfo.name,
    tasks: {}, cascadeRecords: [], selectedVirtues: [], virtueReason: '', finalVirtue: '', aiFeedback: '',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  await ref.set(student);
  return { ...student, createdAt: null, updatedAt: null };
}

async function saveStudentData(student) {
  const clean = JSON.parse(JSON.stringify(student));
  clean.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection('teachers').doc(student.teacherUid).collection('classes').doc(student.classId).collection('students').doc(student.studentId).set(clean, { merge: true });
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ [student.studentId]: clean }));
}

async function signInTeacher() {
  if (auth.currentUser?.isAnonymous) await auth.signOut();
  const result = await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
  if (!result.user.email) throw new Error('이메일이 있는 Google 계정이 필요합니다.');
  await db.collection('teachers').doc(result.user.uid).set({
    email: result.user.email, displayName: result.user.displayName || '체육 선생님',
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return result.user;
}

function requireTeacher() {
  if (!auth.currentUser || auth.currentUser.isAnonymous || !auth.currentUser.email) throw new Error('교사 Google 로그인이 필요합니다.');
  return auth.currentUser;
}

function makeClassCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function createTeacherClass(classData) {
  const teacher = requireTeacher();
  const classRef = db.collection('teachers').doc(teacher.uid).collection('classes').doc();
  let code, codeRef, exists = true;
  while (exists) { code = makeClassCode(); codeRef = db.collection('classCodes').doc(code); exists = (await codeRef.get()).exists; }
  const data = { name: classData.name, grade: classData.grade, classNum: classData.classNum, code, active: true, teacherUid: teacher.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
  const batch = db.batch();
  batch.set(classRef, data);
  batch.set(codeRef, { teacherUid: teacher.uid, classId: classRef.id, className: data.name, active: true });
  await batch.commit();
  return { id: classRef.id, ...data };
}

async function getTeacherClasses() {
  const teacher = requireTeacher();
  const snapshot = await db.collection('teachers').doc(teacher.uid).collection('classes').get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

async function getAllStudentData(classId) {
  const teacher = requireTeacher();
  if (!classId) return [];
  const snapshot = await db.collection('teachers').doc(teacher.uid).collection('classes').doc(classId).collection('students').get();
  return snapshot.docs.map(doc => doc.data());
}

async function deleteStudent(classId, studentId) {
  const teacher = requireTeacher();
  await db.collection('teachers').doc(teacher.uid).collection('classes').doc(classId).collection('students').doc(studentId).delete();
}

async function exportAllData() {
  const classes = await getTeacherClasses(), payloadClasses = [];
  for (const teacherClass of classes) payloadClasses.push({ ...teacherClass, students: await getAllStudentData(teacherClass.id) });
  const payload = { app: '집중력up! 저글링수업', version: 4, exportedAt: new Date().toISOString(), classes: payloadClasses };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `저글링수업_백업_${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

async function exportClassCsv(classId) {
  if (!classId) throw new Error('먼저 학급을 선택해주세요.');
  const classes = await getTeacherClasses();
  const teacherClass = classes.find(item => item.id === classId);
  const students = await getAllStudentData(classId);
  const headers = ['학년', '반', '번호', '이름', '1단계 완료', '2단계 완료', '3단계 완료', '최고기록', '평균기록'];
  for (let i = 1; i <= 10; i += 1) headers.push(`${i}회차`);
  headers.push('핵심가치', '선택한 가치', '가치 선택 이유');
  const stageTotals = { stage1: 5, stage2: 8, stage3: 17 };
  const rows = students
    .sort((a, b) => `${a.grade}-${a.classNum}-${String(a.number).padStart(3, '0')}`.localeCompare(`${b.grade}-${b.classNum}-${String(b.number).padStart(3, '0')}`))
    .map(student => {
      const records = student.cascadeRecords || [];
      const completed = stage => Object.values(student.tasks?.[stage] || {}).filter(Boolean).length;
      const best = records.length ? Math.max(...records) : 0;
      const average = records.length ? Math.round(records.reduce((sum, value) => sum + Number(value || 0), 0) / records.length * 10) / 10 : 0;
      return [student.grade, student.classNum, student.number, student.name,
        `${completed('stage1')}/${stageTotals.stage1}`, `${completed('stage2')}/${stageTotals.stage2}`, `${completed('stage3')}/${stageTotals.stage3}`,
        best, average, ...Array.from({ length: 10 }, (_, index) => records[index] ?? ''),
        student.finalVirtue || '', (student.selectedVirtues || []).join(' · '), student.virtueReason || ''];
    });
  const csv = '\ufeff' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeName = (teacherClass?.name || '학급').replace(/[\\/:*?"<>|]/g, '_');
  link.href = url;
  link.download = `${safeName}_저글링기록_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importAllData() { throw new Error('복원 기능은 다음 업데이트에서 제공됩니다.'); }
