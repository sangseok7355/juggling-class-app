const firebaseConfig = {
  apiKey: 'AIzaSyDulc9AqzZmElAOUFJ-AfAxjEkgplrBqPk',
  authDomain: 'juggling-class-app-910fc.firebaseapp.com',
  projectId: 'juggling-class-app-910fc',
  storageBucket: 'juggling-class-app-910fc.firebasestorage.app',
  messagingSenderId: '771269380032',
  appId: '1:771269380032:web:2824bcdc385d64295aaa25'
};

firebase.initializeApp(firebaseConfig);
window.firebaseConfig = firebaseConfig;
window.firebaseServices = {
  auth: firebase.auth(),
  db: firebase.firestore()
};
