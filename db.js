const STORAGE_KEY = 'juggling_students_v2';
const TEACHER_EMAIL = 'sangseok7355@gmail.com';
const { auth, db } = window.firebaseServices;

async function ensureStudentAuth() {
  if (auth.currentUser && auth.currentUser.isAnonymous) return auth.currentUser;
  if (auth.currentUser) await auth.signOut();
  return (await auth.signInAnonymously()).user;
}

async function getOrCreateStudent(studentInfo) {
  const user = await ensureStudentAuth();
  const ref = db.collection('students').doc(user.uid);
  const snapshot = await ref.get();
  if (snapshot.exists) return snapshot.data();

  const student = {
    studentId: user.uid,
    authUid: user.uid,
    grade: studentInfo.grade,
    classNum: studentInfo.classNum,
    number: studentInfo.number,
    name: studentInfo.name,
    tasks: {},
    cascadeRecords: [],
    selectedVirtues: [],
    virtueReason: '',
    finalVirtue: '',
    aiFeedback: '',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  await ref.set(student);
  return { ...student, createdAt: null, updatedAt: null };
}

async function saveStudentData(student) {
  const clean = JSON.parse(JSON.stringify(student));
  clean.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection('students').doc(student.studentId).set(clean, { merge: true });
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ [student.studentId]: clean }));
}

async function signInTeacher() {
  const provider = new firebase.auth.GoogleAuthProvider();
  const result = await auth.signInWithPopup(provider);
  if (result.user.email !== TEACHER_EMAIL) {
    await auth.signOut();
    throw new Error('등록된 교사 계정만 교사 모드에 접속할 수 있습니다.');
  }
  return result.user;
}

async function getAllStudentData() {
  if (!auth.currentUser || auth.currentUser.email !== TEACHER_EMAIL) {
    throw new Error('교사 Google 로그인이 필요합니다.');
  }
  const snapshot = await db.collection('students').get();
  return snapshot.docs.map(doc => doc.data());
}

async function deleteStudent(studentId) {
  if (!auth.currentUser || auth.currentUser.email !== TEACHER_EMAIL) {
    throw new Error('교사 Google 로그인이 필요합니다.');
  }
  await db.collection('students').doc(studentId).delete();
}

async function exportAllData() {
  const students = await getAllStudentData();
  const payload = { app: '집중력up! 저글링수업', version: 3, exportedAt: new Date().toISOString(), students };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `저글링수업_백업_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importAllData() {
  throw new Error('Firebase 버전의 복원 기능은 다음 업데이트에서 제공됩니다.');
}
