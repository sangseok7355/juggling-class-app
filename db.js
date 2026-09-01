const STORAGE_KEY = 'juggling_students_v2';

function loadStudents() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (e) {
    console.error(e);
    return {};
  }
}

function writeStudents(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

async function getOrCreateStudent(studentInfo) {
  const studentId = `${studentInfo.grade}-${studentInfo.classNum}-${studentInfo.number}-${studentInfo.name}`;
  const all = loadStudents();
  if (all[studentId]) return all[studentId];
  const student = {
    studentId,
    grade: studentInfo.grade,
    classNum: studentInfo.classNum,
    number: studentInfo.number,
    name: studentInfo.name,
    tasks: {}, cascadeRecords: [], selectedVirtues: [], virtueReason: '', finalVirtue: '', aiFeedback: ''
  };
  all[studentId] = student;
  writeStudents(all);
  return student;
}

async function saveStudentData(student) {
  const all = loadStudents();
  all[student.studentId] = JSON.parse(JSON.stringify(student));
  writeStudents(all);
}

async function getAllStudentData() {
  return Object.values(loadStudents());
}

async function deleteStudent(studentId) {
  const all = loadStudents();
  delete all[studentId];
  writeStudents(all);
}

async function exportAllData() {
  const students = await getAllStudentData();
  const payload = {app:'집중력up! 저글링수업', version:2, exportedAt:new Date().toISOString(), students};
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`저글링수업_백업_${new Date().toISOString().slice(0,10)}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

async function importAllData(file) {
  const payload = JSON.parse(await file.text());
  if (!payload || !Array.isArray(payload.students)) throw new Error('올바른 백업 파일이 아닙니다.');
  const all = loadStudents();
  payload.students.forEach(s => all[s.studentId] = s);
  writeStudents(all);
  return payload.students.length;
}
