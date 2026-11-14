import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const ADMIN_EMAIL = "ahmedhamdy2415@gmail.com";
const authScreen = document.querySelector("#auth-screen");
const profileScreen = document.querySelector("#profile-screen");
const appShell = document.querySelector("#app-shell");
const form = document.querySelector("#auth-form");
const emailInput = document.querySelector("#auth-email");
const passwordInput = document.querySelector("#auth-password");
const passwordToggle = document.querySelector("#password-toggle");
const signupRosterField = document.querySelector("#signup-roster-field");
const signupRosterInput = document.querySelector("#signup-roster-id");
const submitButton = document.querySelector("#auth-submit");
const feedback = document.querySelector("#auth-feedback");
const profileForm = document.querySelector("#profile-form");
const profileInput = document.querySelector("#profile-roster-id");
const profileSubmit = document.querySelector("#profile-submit");
const profileFeedback = document.querySelector("#profile-feedback");
const profileCancel = document.querySelector("#profile-cancel");
const profileSignoutButton = document.querySelector("#profile-signout");
const verifyPanel = document.querySelector("#verify-panel");
const resetButton = document.querySelector("#reset-password");
const resendButton = document.querySelector("#resend-verification");
const signoutButton = document.querySelector("#signout-button");
const verifySignoutButton = document.querySelector("#verify-signout");
const editRosterButton = document.querySelector("#edit-roster");
const profileRequestsButton = document.querySelector("#profile-requests-button");
const profileRequestsPanel = document.querySelector("#profile-requests-panel");
const profileRequestList = document.querySelector("#profile-request-list");
const profileRequestsFeedback = document.querySelector("#profile-requests-feedback");
const refreshProfileRequestsButton = document.querySelector("#refresh-profile-requests");
let mode = "login";
let currentUser = null;
let currentProfile = null;

const FIRESTORE_BATCH_SIZE = 400;

async function deletePerformanceDataset(datasetId) {
  const recordsRef = collection(db, "performanceDatasets", datasetId, "records");
  const snapshot = await getDocs(recordsRef);
  for (let start = 0; start < snapshot.docs.length; start += FIRESTORE_BATCH_SIZE) {
    const batch = writeBatch(db);
    snapshot.docs.slice(start, start + FIRESTORE_BATCH_SIZE).forEach((record) => batch.delete(record.ref));
    await batch.commit();
  }
}

async function loadPerformanceRecords(account) {
  const stateSnapshot = await getDoc(doc(db, "performanceState", "current"));
  if (!stateSnapshot.exists()) return [];

  const datasetId = stateSnapshot.data().datasetId;
  if (typeof datasetId !== "string" || !datasetId) {
    throw new Error("إعداد مجموعة بيانات الأداء غير صالح. اطلب من مدير النظام رفع التقرير مرة أخرى.");
  }
  if (!account.isAdmin && !account.pickerId) {
    throw new Error("لم يتم ربط حسابك برقم الروستر.");
  }

  const recordsRef = collection(db, "performanceDatasets", datasetId, "records");
  const recordsQuery = account.isAdmin
    ? recordsRef
    : query(recordsRef, where("picker", "==", account.pickerId));
  const snapshot = await getDocs(recordsQuery);
  return snapshot.docs.map((record) => record.data());
}

async function replacePerformanceRecords(records, onProgress) {
  if (!currentUser || !currentUser.emailVerified || currentUser.email?.toLowerCase() !== ADMIN_EMAIL) {
    throw new Error("رفع بيانات الأداء متاح لحساب المدير الموثّق فقط.");
  }

  const stateRef = doc(db, "performanceState", "current");
  const previousState = await getDoc(stateRef);
  const previousDatasetId = previousState.exists() ? previousState.data().datasetId : null;
  const datasetId = doc(collection(db, "performanceDatasets")).id;
  const recordsRef = collection(db, "performanceDatasets", datasetId, "records");

  try {
    for (let start = 0; start < records.length; start += FIRESTORE_BATCH_SIZE) {
      const batch = writeBatch(db);
      records.slice(start, start + FIRESTORE_BATCH_SIZE).forEach((record, offset) => {
        const recordId = String(start + offset).padStart(6, "0");
        batch.set(doc(recordsRef, recordId), record);
      });
      await batch.commit();
      onProgress?.(Math.min(start + FIRESTORE_BATCH_SIZE, records.length), records.length);
    }

    await setDoc(stateRef, {
      datasetId,
      recordCount: records.length,
      updatedBy: currentUser.uid,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    try {
      await deletePerformanceDataset(datasetId);
    } catch (cleanupError) {
      throw new Error(`${error.message} وتعذر تنظيف الرفع غير المكتمل: ${cleanupError.message}`);
    }
    throw error;
  }

  let cleanupWarning = "";
  if (typeof previousDatasetId === "string" && previousDatasetId && previousDatasetId !== datasetId) {
    try {
      await deletePerformanceDataset(previousDatasetId);
    } catch (error) {
      cleanupWarning = `تم نشر التقرير الجديد، لكن تعذر حذف النسخة السابقة: ${error.message}`;
    }
  }
  return { cleanupWarning };
}

async function submitProfileRequest(pickerId) {
  if (!currentUser || !currentUser.emailVerified) {
    throw new Error("يجب تسجيل الدخول والتحقق من البريد قبل إرسال طلب الربط.");
  }
  await setDoc(doc(db, "pickerProfileRequests", currentUser.uid), {
    email: currentUser.email,
    requestedPickerId: pickerId,
    status: "pending",
    createdAt: serverTimestamp(),
  });
}

async function reviewProfileRequest(userId, requestedPickerId, approved) {
  if (!currentUser || currentUser.email?.toLowerCase() !== ADMIN_EMAIL) {
    throw new Error("مراجعة طلبات الربط متاحة للمدير فقط.");
  }
  const requestRef = doc(db, "pickerProfileRequests", userId);
  await runTransaction(db, async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists() || requestSnapshot.data().status !== "pending") {
      throw new Error("تمت مراجعة هذا الطلب بالفعل. حدّث قائمة الطلبات.");
    }

    const freshRequest = requestSnapshot.data();
    if (freshRequest.requestedPickerId !== requestedPickerId) {
      throw new Error("تغيّر رقم الروستر بعد تحميل الطلب. حدّث قائمة الطلبات وراجعه من جديد.");
    }
    if (approved) {
      const duplicateProfiles = await transaction.get(query(
        collection(db, "pickerAccounts"),
        where("pickerId", "==", freshRequest.requestedPickerId),
      ));
      if (duplicateProfiles.docs.some((profile) => profile.id !== userId && profile.data().approved === true)) {
        throw new Error("رقم الروستر مرتبط بحساب آخر بالفعل.");
      }
      transaction.set(doc(db, "pickerAccounts", userId), {
        email: freshRequest.email,
        pickerId: freshRequest.requestedPickerId,
        approved: true,
      });
    }
    transaction.update(requestRef, {
      status: approved ? "approved" : "rejected",
      reviewedBy: currentUser.uid,
      reviewedAt: serverTimestamp(),
    });
  });
}

async function loadProfileRequests() {
  if (!currentUser || currentUser.email?.toLowerCase() !== ADMIN_EMAIL) {
    throw new Error("عرض طلبات الربط متاح للمدير فقط.");
  }
  profileRequestsFeedback.hidden = true;
  profileRequestList.replaceChildren();
  try {
    const snapshot = await getDocs(collection(db, "pickerProfileRequests"));
    const pendingRequests = snapshot.docs
      .map((requestSnapshot) => ({ id: requestSnapshot.id, ...requestSnapshot.data() }))
      .filter((request) => request.status === "pending");
    if (!pendingRequests.length) {
      profileRequestList.textContent = "لا توجد طلبات ربط معلّقة.";
      return;
    }

    pendingRequests.forEach((request) => {
      const row = document.createElement("div");
      row.className = "profile-request-item";
      const details = document.createElement("div");
      details.className = "profile-request-meta";
      const email = document.createElement("strong");
      email.textContent = request.email;
      const pickerId = document.createElement("small");
      pickerId.textContent = `رقم الروستر المطلوب: ${request.requestedPickerId}`;
      details.append(email, pickerId);

      const actions = document.createElement("div");
      actions.className = "profile-request-actions";
      const approveButton = document.createElement("button");
      approveButton.className = "profile-request-approve";
      approveButton.textContent = "اعتماد";
      const rejectButton = document.createElement("button");
      rejectButton.className = "profile-request-reject";
      rejectButton.textContent = "رفض";
      const handleReview = async (approved) => {
        approveButton.disabled = true;
        rejectButton.disabled = true;
        profileRequestsFeedback.hidden = true;
        try {
          await reviewProfileRequest(request.id, request.requestedPickerId, approved);
          await loadProfileRequests();
        } catch (error) {
          profileRequestsFeedback.textContent = friendlyError(error);
          profileRequestsFeedback.hidden = false;
          approveButton.disabled = false;
          rejectButton.disabled = false;
        }
      };
      approveButton.addEventListener("click", () => handleReview(true));
      rejectButton.addEventListener("click", () => handleReview(false));
      actions.append(approveButton, rejectButton);
      row.append(details, actions);
      profileRequestList.append(row);
    });
  } catch (error) {
    profileRequestsFeedback.textContent = friendlyError(error);
    profileRequestsFeedback.hidden = false;
  }
}

function showFeedback(message = "") {
  feedback.textContent = message;
  feedback.hidden = !message;
}

function showAuth() {
  authScreen.hidden = false;
  profileScreen.hidden = true;
  appShell.hidden = true;
  verifyPanel.hidden = true;
  resetButton.hidden = false;
}

function showProfile(message = "") {
  authScreen.hidden = true;
  profileScreen.hidden = false;
  appShell.hidden = true;
  profileFeedback.textContent = message;
  profileFeedback.hidden = !message;
  profileCancel.hidden = !currentProfile;
  if (currentProfile) profileInput.value = currentProfile.pickerId;
}

function showDashboard(user, profile, isAdmin) {
  currentUser = user;
  currentProfile = profile;
  const pickerId = profile?.pickerId || "";
  window.performanceAccount = { isAdmin, pickerId };
  authScreen.hidden = true;
  profileScreen.hidden = true;
  appShell.hidden = false;
  document.querySelector("#account-role").textContent = isAdmin ? "مدير النظام" : "محضّر طلبات";
  document.querySelector("#account-email").textContent = isAdmin ? user.email : `Roster ID: ${pickerId}`;
  editRosterButton.hidden = isAdmin;
  profileRequestsButton.hidden = !isAdmin;
  if (!isAdmin) profileRequestsPanel.hidden = true;
  window.dispatchEvent(new Event("auth-ready"));
}

function setMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    const active = button.dataset.authMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  submitButton.textContent = mode === "signup" ? "إنشاء الحساب" : "تسجيل الدخول";
  passwordInput.autocomplete = mode === "signup" ? "new-password" : "current-password";
  signupRosterField.hidden = mode !== "signup";
  signupRosterInput.required = mode === "signup";
  resetButton.hidden = mode === "signup";
  showFeedback();
}

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use": "هذا البريد مسجّل بالفعل. سجّل الدخول بدلًا من إنشاء حساب جديد.",
    "auth/invalid-email": "تحقق من كتابة البريد الإلكتروني بشكل صحيح.",
    "auth/invalid-credential": "البريد أو كلمة المرور غير صحيحة.",
    "auth/weak-password": "كلمة المرور قصيرة؛ استخدم 6 أحرف على الأقل.",
    "auth/too-many-requests": "محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.",
    "auth/network-request-failed": "تعذر الاتصال. تحقق من الإنترنت وحاول مرة أخرى.",
    "auth/operation-not-allowed": "فعّل تسجيل الدخول بالبريد وكلمة المرور في إعدادات Firebase.",
    "auth/unauthorized-domain": "أضف نطاق الموقع إلى النطاقات المسموح بها في Firebase Authentication.",
    "auth/invalid-api-key": "إعداد Firebase غير صحيح. راجع firebase-config.js.",
    "permission-denied": "ليس لديك صلاحية حفظ بيانات الحساب. تحقق من نشر قواعد Firestore.",
    "unavailable": "خدمة Firestore غير متاحة. تحقق من إعداد قاعدة البيانات والاتصال.",
  };
  return messages[error.code] || `تعذر إكمال العملية: ${error.message}`;
}

document.querySelectorAll("[data-auth-mode]").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.authMode));
});

passwordToggle.addEventListener("click", () => {
  const isVisible = passwordInput.type === "text";
  passwordInput.type = isVisible ? "password" : "text";
  passwordToggle.textContent = isVisible ? "إظهار" : "إخفاء";
  passwordToggle.setAttribute("aria-label", isVisible ? "إظهار كلمة المرور" : "إخفاء كلمة المرور");
  passwordToggle.setAttribute("aria-pressed", String(!isVisible));
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showFeedback();
  submitButton.disabled = true;
  try {
    if (mode === "signup") {
      const pickerId = signupRosterInput.value.trim();
      if (!/^\d+$/.test(pickerId)) {
        showFeedback("اكتب رقم الروستر بالأرقام فقط.");
        signupRosterInput.focus();
        return;
      }
      const credential = await createUserWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
      localStorage.setItem(`talabat-roster-${credential.user.uid}`, pickerId);
      await sendEmailVerification(credential.user);
      await signOut(auth);
      showAuth();
      verifyPanel.hidden = false;
      resetButton.hidden = true;
      showFeedback("أُنشئ الحساب. تحقق من بريدك الإلكتروني لتفعيل الدخول.");
    } else {
      await signInWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
    }
  } catch (error) {
    showFeedback(friendlyError(error));
  } finally {
    submitButton.disabled = false;
  }
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pickerId = profileInput.value.trim();
  if (!currentUser || !/^\d+$/.test(pickerId)) {
    profileFeedback.textContent = "اكتب رقم الروستر بالأرقام فقط.";
    profileFeedback.hidden = false;
    return;
  }
  profileSubmit.disabled = true;
  profileFeedback.hidden = true;
  try {
    await submitProfileRequest(pickerId);
    localStorage.removeItem(`talabat-roster-${currentUser.uid}`);
    profileInput.value = pickerId;
    profileFeedback.textContent = "تم إرسال طلب الربط للمدير. سيظهر الأداء بعد اعتماده.";
    profileFeedback.hidden = false;
  } catch (error) {
    profileFeedback.textContent = friendlyError(error);
    profileFeedback.hidden = false;
  } finally {
    profileSubmit.disabled = false;
  }
});

profileCancel.addEventListener("click", () => {
  if (!currentUser || !currentProfile) return;
  showDashboard(currentUser, currentProfile, false);
});

resetButton.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  if (!email) {
    showFeedback("اكتب بريدك الإلكتروني أولًا لإرسال رابط إعادة تعيين كلمة المرور.");
    emailInput.focus();
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    showFeedback("إذا كان البريد مسجّلًا، فسيصلك رابط آمن. افتحه لإنشاء كلمة مرور جديدة؛ لن نرسل كلمة المرور نفسها بالبريد.");
  } catch (error) {
    showFeedback(friendlyError(error));
  }
});

resendButton.addEventListener("click", async () => {
  if (!auth.currentUser) return;
  try {
    await sendEmailVerification(auth.currentUser);
    showFeedback("أُعيد إرسال رسالة التحقق.");
  } catch (error) {
    showFeedback(friendlyError(error));
  }
});

async function handleSignout() {
  try {
    await signOut(auth);
  } catch (error) {
    showFeedback(friendlyError(error));
  }
}

signoutButton.addEventListener("click", handleSignout);
verifySignoutButton.addEventListener("click", handleSignout);
profileSignoutButton.addEventListener("click", handleSignout);
editRosterButton.addEventListener("click", () => showProfile());
profileRequestsButton.addEventListener("click", async () => {
  profileRequestsPanel.hidden = false;
  profileRequestsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  await loadProfileRequests();
});
refreshProfileRequestsButton.addEventListener("click", loadProfileRequests);

let auth;
let db;
try {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  window.performanceDatabase = {
    loadRecords: loadPerformanceRecords,
    replaceRecords: replacePerformanceRecords,
  };
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      currentUser = null;
      currentProfile = null;
      showAuth();
      return;
    }
    if (!user.emailVerified) {
      showAuth();
      verifyPanel.hidden = false;
      resetButton.hidden = true;
      showFeedback("يجب التحقق من بريدك الإلكتروني قبل الدخول.");
      return;
    }
    const isAdmin = user.email?.toLowerCase() === ADMIN_EMAIL;
    if (isAdmin) {
      showDashboard(user, null, true);
      return;
    }
    try {
      const profileRef = doc(db, "pickerAccounts", user.uid);
      const profileSnapshot = await getDoc(profileRef);
      if (profileSnapshot.exists() && profileSnapshot.data().approved === true) {
        showDashboard(user, profileSnapshot.data(), false);
        return;
      }
      const savedPickerId = localStorage.getItem(`talabat-roster-${user.uid}`);
      if (savedPickerId) {
        currentUser = user;
        await submitProfileRequest(savedPickerId);
        localStorage.removeItem(`talabat-roster-${user.uid}`);
        showProfile("تم إرسال طلب الربط للمدير. سيظهر الأداء بعد اعتماده.");
        profileInput.value = savedPickerId;
        return;
      }
      currentUser = user;
      currentProfile = null;
      const requestSnapshot = await getDoc(doc(db, "pickerProfileRequests", user.uid));
      if (requestSnapshot.exists()) {
        const request = requestSnapshot.data();
        profileInput.value = request.requestedPickerId || "";
        showProfile(request.status === "pending"
          ? "طلبك قيد المراجعة. سجّل الخروج ثم الدخول بعد موافقة المدير."
          : "لم يُعتمد الطلب. راجع رقم الروستر وأرسل طلبًا جديدًا.");
      } else {
        showProfile();
      }
    } catch (error) {
      showAuth();
      showFeedback(friendlyError(error));
    }
  }, (error) => {
    showAuth();
    showFeedback(friendlyError(error));
  });
} catch (error) {
  showAuth();
  showFeedback(`تعذر تشغيل تسجيل الدخول: ${friendlyError(error)} حدّث إعدادات Firebase ثم أعد تحميل الصفحة.`);
}
