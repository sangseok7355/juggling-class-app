const STORAGE_KEY = 'juggling_students_v3';
const { auth, db } = window.firebaseServices;

const cleanStudentKeyPart = value => String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, '');

function makeStudentLoginKey(studentInfo) {
  return [studentInfo.classCode, studentInfo.grade, studentInfo.classNum, studentInfo.number].map(cleanStudentKeyPart).join('_');
}

function makeStudentEmail(studentInfo) {
  return `student.${cleanStudentKeyPart(studentInfo.classCode)}.${cleanStudentKeyPart(studentInfo.grade)}.${cleanStudentKeyPart(studentInfo.classNum)}.${cleanStudentKeyPart(studentInfo.number)}@juggling.local`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function makeStudentPinAlias(studentInfo, pin) {
  const key = makeStudentLoginKey(studentInfo);
  return (await sha256Hex(`juggling-student-pin-v1|${key}|${pin}`)).slice(0, 20);
}

function makeResetStudentEmail(studentInfo, pinAlias) {
  const legacy = makeStudentEmail(studentInfo);
  return legacy.replace('@juggling.local', `.r${pinAlias}@juggling.local`);
}

function isMissingCredential(error) {
  return ['auth/user-not-found', 'auth/wrong-password', 'auth/invalid-credential', 'auth/invalid-login-credentials'].includes(error?.code);
}

async function ensureLegacyStudentAuth(studentInfo) {
  const email = makeStudentEmail(studentInfo);
  try {
    return (await auth.signInWithEmailAndPassword(email, studentInfo.pin)).user;
  } catch (signInError) {
    if (!isMissingCredential(signInError)) throw signInError;
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

async function ensureStudentAuth(studentInfo) {
  if (auth.currentUser) await auth.signOut();
  const pinAlias = await makeStudentPinAlias(studentInfo, studentInfo.pin);
  const resetEmail = makeResetStudentEmail(studentInfo, pinAlias);
  try {
    const user = (await auth.signInWithEmailAndPassword(resetEmail, studentInfo.pin)).user;
    return { user, pinAlias, usedResetLogin: true };
  } catch (resetSignInError) {
    if (!isMissingCredential(resetSignInError)) throw resetSignInError;
  }
  return { user: await ensureLegacyStudentAuth(studentInfo), pinAlias, usedResetLogin: false };
}

async function getOrCreateStudent(studentInfo) {
  let login = await ensureStudentAuth(studentInfo);
  const classCode = studentInfo.classCode.trim().toUpperCase();
  const codeSnapshot = await db.collection('classCodes').doc(classCode).get();
  if (!codeSnapshot.exists) throw new Error('학급 코드를 확인해주세요.');
  const classInfo = codeSnapshot.data();
  const loginKey = makeStudentLoginKey(studentInfo);
  const expectedPinAlias = classInfo.studentPinAliases?.[loginKey] || '';
  if (login.usedResetLogin && !expectedPinAlias) {
    await auth.signOut();
    login = { user: await ensureLegacyStudentAuth(studentInfo), pinAlias: login.pinAlias, usedResetLogin: false };
  }
  if (expectedPinAlias && (!login.usedResetLogin || login.pinAlias !== expectedPinAlias)) {
    await auth.signOut();
    throw new Error('개인 PIN이 일치하지 않습니다. 선생님께 새 PIN을 확인해주세요.');
  }
  const user = login.user;
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

async function isTeacherApprovalPinConfigured() {
  const teacher = requireTeacher();
  const snapshot = await db.collection('teachers').doc(teacher.uid).get();
  return Boolean(snapshot.data()?.approvalPinHash);
}

async function setTeacherApprovalPin(pin) {
  const teacher = requireTeacher();
  if (!/^\d{6}$/.test(pin)) throw new Error('교사 확인 비밀번호는 숫자 6자리로 설정해주세요.');
  const pinHash = await sha256Hex(`juggling-teacher-pin-v1|${teacher.uid}|${pin}`);
  const classes = await getTeacherClasses();
  const batch = db.batch();
  batch.set(db.collection('teachers').doc(teacher.uid), {
    approvalPinHash: pinHash,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  classes.filter(item => item.code).forEach(item => {
    batch.set(db.collection('classCodes').doc(item.code), { approvalPinHash: pinHash }, { merge: true });
  });
  await batch.commit();
}

async function verifyTeacherApprovalPin(classCode, pin) {
  if (!/^\d{6}$/.test(pin)) return false;
  const snapshot = await db.collection('classCodes').doc(String(classCode || '').trim().toUpperCase()).get();
  if (!snapshot.exists) throw new Error('학급 정보를 찾을 수 없습니다.');
  const data = snapshot.data();
  if (!data.approvalPinHash) throw new Error('선생님이 교사 확인 비밀번호를 아직 설정하지 않았습니다.');
  const pinHash = await sha256Hex(`juggling-teacher-pin-v1|${data.teacherUid}|${pin}`);
  return pinHash === data.approvalPinHash;
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
  const teacherSnapshot = await db.collection('teachers').doc(teacher.uid).get();
  const approvalPinHash = teacherSnapshot.data()?.approvalPinHash || '';
  const classRef = db.collection('teachers').doc(teacher.uid).collection('classes').doc();
  let code, codeRef, exists = true;
  while (exists) { code = makeClassCode(); codeRef = db.collection('classCodes').doc(code); exists = (await codeRef.get()).exists; }
  const data = { name: classData.name, grade: classData.grade, classNum: classData.classNum, code, active: true, teacherUid: teacher.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
  const batch = db.batch();
  batch.set(classRef, data);
  batch.set(codeRef, { teacherUid: teacher.uid, classId: classRef.id, className: data.name, active: true, ...(approvalPinHash ? { approvalPinHash } : {}) });
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

async function resetStudentPin(classId, student, newPin) {
  const teacher = requireTeacher();
  if (!/^\d{6}$/.test(newPin)) throw new Error('학생의 새 PIN은 숫자 6자리로 입력해주세요.');
  if (!student || student.teacherUid !== teacher.uid || student.classId !== classId) throw new Error('학생 정보를 다시 확인해주세요.');

  const pinAlias = await makeStudentPinAlias(student, newPin);
  const resetEmail = makeResetStudentEmail(student, pinAlias);
  const secondaryName = `student-pin-reset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const secondaryApp = firebase.initializeApp(window.firebaseConfig, secondaryName);
  const secondaryAuth = secondaryApp.auth();
  let newUser;
  try {
    try {
      newUser = (await secondaryAuth.createUserWithEmailAndPassword(resetEmail, newPin)).user;
    } catch (createError) {
      if (createError.code !== 'auth/email-already-in-use') throw createError;
      newUser = (await secondaryAuth.signInWithEmailAndPassword(resetEmail, newPin)).user;
    }

    const migratedStudent = {
      ...student,
      studentId: newUser.uid,
      authUid: newUser.uid,
      pinAlias,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await secondaryApp.firestore().collection('teachers').doc(teacher.uid).collection('classes').doc(classId).collection('students').doc(newUser.uid).set(migratedStudent, { merge: true });

    const batch = db.batch();
    const codeRef = db.collection('classCodes').doc(student.classCode);
    batch.update(codeRef, new firebase.firestore.FieldPath('studentPinAliases', makeStudentLoginKey(student)), pinAlias);
    if (newUser.uid !== student.studentId) {
      batch.delete(db.collection('teachers').doc(teacher.uid).collection('classes').doc(classId).collection('students').doc(student.studentId));
    }
    await batch.commit();
    return { ...migratedStudent, updatedAt: null };
  } finally {
    try { await secondaryAuth.signOut(); } catch {}
    try { await secondaryApp.delete(); } catch {}
  }
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
  headers.push('선택한 마음가짐', '선택 이유');
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
        (student.selectedVirtues || (student.finalVirtue ? [student.finalVirtue] : [])).join(' · '), student.virtueReason || ''];
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
