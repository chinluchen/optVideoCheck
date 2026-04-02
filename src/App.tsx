import React, { useState, useEffect, useRef } from 'react';
import { YoutubeTranscript } from 'youtube-transcript';
import { 
  Youtube, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  ClipboardCheck, 
  ArrowRight,
  Glasses,
  ShieldCheck,
  Info,
  RefreshCw,
  PlusCircle,
  Copy,
  Download,
  Search,
  Check,
  GripVertical,
  Trash2,
  Plus,
  Upload,
  LogOut,
  LogIn,
  User as UserIcon,
  FileVideo,
  History
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  DndContext, 
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Firebase imports removed - now using Cloud Run Backend API
// import { auth, db, storage } from './firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  signInAnonymously,
  User
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import { 
  ref, 
  uploadBytesResumable, 
  getDownloadURL 
} from 'firebase/storage';

// Standard Optometry Steps for Reference
const DEFAULT_STEPS: Step[] = [
  { id: "1", title: "消毒雙手與儀器 (Sanitization)", correctAnswer: "操作者應使用 75% 酒精徹底消毒雙手，並擦拭驗光儀器之額托與下巴托。" },
  { id: "2", title: "調整受檢者坐姿與下巴托 (Patient Positioning)", correctAnswer: "受檢者應坐穩，下巴靠在托架上，額頭緊貼額托，調整高度使受檢者眼睛對準儀器刻度。" },
  { id: "3", title: "電腦驗光 (Auto-Refraction)", correctAnswer: "操作者應指示受檢者注視儀器內的熱氣球或目標，並在對焦準確後進行至少三次測量。" },
  { id: "4", title: "自覺式驗光 - 霧視法 (Subjective Refraction - Fogging)", correctAnswer: "在進行自覺式驗光前，應先加入正度數鏡片使視力模糊（霧視），以放鬆調節力。" },
  { id: "5", title: "紅綠測試 (Red-Green Test)", correctAnswer: "受檢者應比較紅綠背景下的視標清晰度，若綠色較清楚則減少負度數，若紅色較清楚則增加負度數。" },
  { id: "6", title: "散光軸度與度數調整 (Cross Cylinder Adjustment)", correctAnswer: "使用交叉圓柱鏡 (JCC) 進行精確的散光軸度與度數調整，根據受檢者反應旋轉軸度。" },
  { id: "7", title: "雙眼平衡 (Binocular Balance)", correctAnswer: "使用稜鏡分離法或霧視法，確保雙眼在看遠時的調節狀態一致且平衡。" },
  { id: "8", title: "試戴與最終處方確認 (Final Prescription Confirmation)", correctAnswer: "讓受檢者戴上試鏡架行走，確認是否有晃動感、頭暈或不適，並進行最終度數微調。" }
];

interface Step {
  id: string;
  title: string;
  correctAnswer: string;
}

interface VerificationResult {
  isCorrect: boolean;
  score: number;
  feedback: string;
  detectedSteps: string[];
  missingSteps: string[];
  transcript: string;
}

interface SortableStepItemProps {
  step: Step;
  index: number;
  isEditing: boolean;
  onToggle: () => void;
  onUpdateAnswer: (answer: string) => void;
  onDelete: () => void;
  onUpdateTitle: (title: string) => void;
}

const SortableStepItem: React.FC<SortableStepItemProps> = ({ 
  step, 
  index, 
  isEditing, 
  onToggle, 
  onUpdateAnswer, 
  onDelete,
  onUpdateTitle
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 'auto',
    position: 'relative' as const,
  };

  return (
    <div ref={setNodeRef} style={style} className="space-y-2">
      <div className={`w-full flex items-center gap-2 p-2 rounded-xl border transition-all ${isEditing ? 'bg-indigo-50 border-indigo-200 ring-2 ring-indigo-500/10' : 'bg-zinc-50 border-zinc-100 hover:border-zinc-300'}`}>
        <div 
          {...attributes} 
          {...listeners} 
          className="p-2 cursor-grab active:cursor-grabbing text-zinc-400 hover:text-zinc-600"
        >
          <GripVertical className="w-4 h-4" />
        </div>
        
        <div className="flex-1 flex items-center gap-3">
          <span className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-600 shrink-0">
            {index + 1}
          </span>
          <input 
            type="text"
            value={step.title}
            onChange={(e) => onUpdateTitle(e.target.value)}
            className="flex-1 bg-transparent border-none focus:ring-0 text-sm font-bold text-zinc-700 p-0"
            placeholder="步驟標題"
          />
        </div>

        <div className="flex items-center gap-2">
          {step.correctAnswer ? (
            <span className="hidden sm:inline-block text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-bold">已設定答案</span>
          ) : (
            <span className="hidden sm:inline-block text-[10px] bg-zinc-200 text-zinc-500 px-2 py-0.5 rounded-full font-bold">未設定</span>
          )}
          <button 
            onClick={onToggle}
            className="p-2 hover:bg-white rounded-lg transition-colors text-zinc-400 hover:text-indigo-600"
          >
            <ArrowRight className={`w-4 h-4 transition-transform ${isEditing ? 'rotate-90' : ''}`} />
          </button>
          <button 
            onClick={onDelete}
            className="p-2 hover:bg-red-50 rounded-lg transition-colors text-zinc-400 hover:text-red-500"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      
      <AnimatePresence>
        {isEditing && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="p-4 bg-white border border-indigo-100 rounded-xl space-y-3 mb-4 ml-8">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">正確答案 / 評分參考要點</label>
                <Info className="w-3 h-3 text-indigo-300" />
              </div>
              <textarea 
                value={step.correctAnswer}
                onChange={(e) => onUpdateAnswer(e.target.value)}
                className="w-full h-32 bg-zinc-50 border border-zinc-200 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                placeholder="請輸入此步驟的正確操作細節，AI 將以此為基準進行評分..."
              />
              <div className="flex justify-end">
                <button 
                  onClick={onToggle}
                  className="text-xs font-bold text-indigo-600 hover:text-indigo-700 px-3 py-1.5 rounded-lg bg-indigo-50"
                >
                  完成編輯
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default function App() {
  const [view, setView] = useState<'student' | 'teacher' | 'history'>('student');
  const [user, setUser] = useState<{uid: string, displayName: string, role: 'student' | 'teacher', isGuest?: boolean} | null>(null);
  const [userRole, setUserRole] = useState<'student' | 'teacher' | null>(null);
  const [isTeacherLoggedIn, setIsTeacherLoggedIn] = useState(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [url, setUrl] = useState('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [standardSteps, setStandardSteps] = useState<Step[]>(DEFAULT_STEPS);
  const [selectedSteps, setSelectedSteps] = useState<string[]>(DEFAULT_STEPS.map(s => s.title));
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isLoginDropdownOpen, setIsLoginDropdownOpen] = useState(false);
  const [editingStepIndex, setEditingStepIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [transcriptionStatus, setTranscriptionStatus] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auth Listener - Replaced with simple local state for Cloud Run
  useEffect(() => {
    // Check if there's a saved session in localStorage
    const savedUser = localStorage.getItem('app_user');
    if (savedUser) {
      const parsedUser = JSON.parse(savedUser);
      setUser(parsedUser);
      setUserRole(parsedUser.role);
    }
  }, []);

  // Sync steps from Backend
  useEffect(() => {
    const fetchSteps = async () => {
      try {
        const res = await fetch('/api/health'); // Just checking connection
        // In a real app, we'd have a /api/config endpoint
      } catch (err) {
        console.error("Backend connection failed:", err);
      }
    };
    fetchSteps();
  }, []);

  // Fetch submissions from Backend
  useEffect(() => {
    const fetchSubmissions = async () => {
      try {
        const res = await fetch('/api/submissions');
        const data = await res.json();
        if (userRole === 'teacher') {
          setSubmissions(data);
        } else if (user) {
          setSubmissions(data.filter((s: any) => s.studentUid === user.uid));
        }
      } catch (err) {
        console.error("Failed to fetch history:", err);
      }
    };

    if (user) {
      fetchSubmissions();
      const interval = setInterval(fetchSubmissions, 10000);
      return () => clearInterval(interval);
    }
  }, [user, userRole]);

  const handleGoogleLogin = async () => {
    // Simplified for Cloud Run demo - in production use real OAuth
    const mockUser = {
      uid: 'google-user-123',
      displayName: '測試老師 (Google)',
      email: 'test@gmail.com',
      role: 'teacher' as const
    };
    setUser(mockUser);
    setUserRole('teacher');
    localStorage.setItem('app_user', JSON.stringify(mockUser));
  };

  const handleGuestLogin = async (role: 'student' | 'teacher') => {
    const guestUser = {
      uid: `guest-${Math.random().toString(36).substr(2, 9)}`,
      displayName: `訪客${role === 'teacher' ? '教師' : '學生'}`,
      role: role,
      isGuest: true
    };
    setUser(guestUser);
    setUserRole(role);
    localStorage.setItem('app_user', JSON.stringify(guestUser));
  };

  const handleLogout = async () => {
    setUser(null);
    setUserRole(null);
    localStorage.removeItem('app_user');
    setIsTeacherLoggedIn(false);
    setView('student');
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 100 * 1024 * 1024) { // 100MB limit
        setError('檔案太大，請上傳小於 100MB 的影片');
        return;
      }
      setVideoFile(file);
      setUrl('');
      setError(null);
    }
  };

  const handleCopyTranscript = () => {
    if (!result?.transcript) return;
    navigator.clipboard.writeText(result.transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadTranscript = () => {
    if (!result?.transcript) return;
    const blob = new Blob([result.transcript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript_${new Date().getTime()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleStep = (step: string) => {
    setSelectedSteps(prev => 
      prev.includes(step) 
        ? prev.filter(s => s !== step) 
        : [...prev, step]
    );
  };

  const updateStepAnswer = (index: number, answer: string) => {
    const newSteps = [...standardSteps];
    newSteps[index] = { ...newSteps[index], correctAnswer: answer };
    setStandardSteps(newSteps);
    // Sync to Backend if teacher
    if (isTeacherLoggedIn || userRole === 'teacher') {
      // In a real app, we'd have a /api/config endpoint
      // For now, we just update local state
      console.log("Steps updated locally");
    }
  };

  const handleReset = () => {
    setResult(null);
    setUrl('');
    setVideoFile(null);
    setUploadProgress(null);
    setError(null);
    setLoading(false);
  };

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setStandardSteps((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const addNewStep = () => {
    const newId = Math.random().toString(36).substr(2, 9);
    const newTitle = `新步驟 ${standardSteps.length + 1}`;
    setStandardSteps([...standardSteps, { id: newId, title: newTitle, correctAnswer: "" }]);
  };

  const checkConfiguration = () => {
    const missingAnswers = standardSteps.filter(s => !s.correctAnswer);
    if (missingAnswers.length > 0) {
      alert(`注意：尚有 ${missingAnswers.length} 個步驟未設定正確答案。`);
    } else {
      alert('檢查完畢：所有步驟皆已設定正確答案！');
    }
  };

  const deleteStep = (index: number) => {
    const newSteps = standardSteps.filter((_, i) => i !== index);
    setStandardSteps(newSteps);
    if (editingStepIndex === index) setEditingStepIndex(null);
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginUsername === 'teacher' && loginPassword === 'student') {
      setIsTeacherLoggedIn(true);
      setLoginError('');
    } else {
      setLoginError('帳號或密碼錯誤');
    }
  };

  const handleVerify = async () => {
    if (!user) {
      setError('請先登入系統');
      return;
    }

    if (!url.trim() && !videoFile) {
      setError('請輸入 YouTube 連結或上傳影片檔案');
      return;
    }

    if (url.trim() && !url.includes('youtube.com') && !url.includes('youtu.be')) {
      setError('請輸入有效的 YouTube 連結');
      return;
    }

    if (selectedSteps.length === 0) {
      setError('請至少選擇一個要驗證的步驟');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      let finalVideoUrl = url;
      let videoData: any = null;

      // Handle File Upload - Direct to Gemini via Backend
      if (videoFile) {
        setUploadProgress(5);
        
        // Convert to base64 for Gemini
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(videoFile);
        });
        
        setUploadProgress(10);
        videoData = {
          inlineData: {
            data: base64,
            mimeType: videoFile.type
          }
        };
        finalVideoUrl = "本地上傳影片";
      }

      // Verification logic now handled by backend /api/verify
      let actualTranscript = "";
      if (url.trim()) {
        try {
          setTranscriptionStatus('正在啟動後台轉錄程序...');
          const transcribeRes = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoUrl: url })
          });
          
          if (!transcribeRes.ok) throw new Error('無法啟動轉錄程序');
          
          const { id } = await transcribeRes.json();
          
          // Polling
          let status = 'pending';
          let attempts = 0;
          const maxAttempts = 60; // 3 minutes max

          while ((status === 'pending' || status === 'processing') && attempts < maxAttempts) {
            attempts++;
            await new Promise(r => setTimeout(r, 3000));
            const pollRes = await fetch(`/api/transcription/${id}`);
            const pollData = await pollRes.json();
            status = pollData.status;
            
            if (status === 'processing') {
              setTranscriptionStatus('正在下載並轉錄音訊...');
            } else if (status === 'completed') {
              actualTranscript = pollData.transcript;
              setTranscriptionStatus('轉錄完成！');
            } else if (status === 'failed') {
              console.warn("Whisper transcription failed:", pollData.error);
              setTranscriptionStatus('轉錄失敗，嘗試備用方案...');
              // Fallback to old method
              try {
                const transcriptItems = await YoutubeTranscript.fetchTranscript(url);
                actualTranscript = transcriptItems
                  .map(item => `[${Math.floor(item.offset / 1000 / 60)}:${(Math.floor(item.offset / 1000) % 60).toString().padStart(2, '0')}] ${item.text}`)
                  .join('\n');
              } catch (e) {}
              break;
            }
          }
        } catch (transcriptErr) {
          console.warn("Transcription queue error:", transcriptErr);
          // Fallback to old method
          try {
            const transcriptItems = await YoutubeTranscript.fetchTranscript(url);
            actualTranscript = transcriptItems
              .map(item => `[${Math.floor(item.offset / 1000 / 60)}:${(Math.floor(item.offset / 1000) % 60).toString().padStart(2, '0')}] ${item.text}`)
              .join('\n');
          } catch (e) {}
        } finally {
          setTimeout(() => setTranscriptionStatus(null), 2000);
        }
      }

      const prompt = `
        你是一位【極度挑剔且冷酷】的「驗光臨床技術考官」。你的唯一目標是找出學生操作中的「缺失」。
        
        【核心指令：絕對禁止幻覺】：
        1. 證據門檻：只有在影片中「清晰可見」的手部動作，或「清晰可聞」的完整對話，才能被認定為已執行。
        2. 疑點利益歸於考官：如果畫面模糊、角度不對、聲音不清楚，一律判定為「未執行」或「缺失」。
        3. 嚴禁推論：絕對不可因為學生做了 A 動作，就推論他「應該也做了」B 動作。
        4. 嚴禁腦補：不可將背景雜音或模糊的陰影解讀為特定的操作步驟。
        
        【分析流程 - 必須嚴格遵守】：
        第一步：【原始觀察紀錄】
        請按時間順序，逐秒列出你「確切看到」的動作與「確切聽到」的對話。
        格式：[分:秒] 動作描述 / 對話內容。
        (如果這部分你寫不出來，後面的評分就必須是 0 分)

        第二步：【嚴苛比對】
        將上述「原始觀察紀錄」與下方的「正確操作要點」進行比對。
        只要有一點點不符（例如：指令說錯一個字、手勢位置偏離 5 公分、順序顛倒），就必須扣分。

        第三步：【最終裁決】
        給出評分與回饋。

        【學生選擇驗證的步驟與標準】：
        ${selectedSteps.map((title, i) => {
          const step = standardSteps.find(s => s.title === title);
          return `步驟 ${i + 1}: ${title}\n- 絕對正確標準：${step?.correctAnswer || '無特定要求'}`;
        }).join('\n\n')}

        ${url ? `影片連結：${url}` : "影片已隨附於此請求中。"}
        ${actualTranscript ? `【系統提取之原始逐字稿（僅供參考，請以影片實際聽到的為準）】：\n${actualTranscript}\n` : ""}

        請以 JSON 格式回傳，結構如下：
        {
          "isCorrect": boolean,
          "score": number (0-100),
          "reasoning": "請在此列出你的「原始觀察紀錄」，並說明為什麼這些證據不足以支持學生過關。請特別指出你『沒看到』什麼。",
          "feedback": "請以嚴厲的口吻指出學生的錯誤，並要求其改進具體細節。",
          "detectedSteps": ["影片中 100% 確定有做到的步驟名稱"],
          "missingSteps": ["影片中沒看到、看不清、或做錯的步驟名稱"],
          "transcript": "請提供你整理後的精確影片紀錄（含時間戳記），若無證據請留空"
        }
      `;

      // Call Backend API with real upload progress
      const data = await new Promise<any>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/verify');
        xhr.setRequestHeader('Content-Type', 'application/json');
        
        // Start a timer to simulate analysis progress once upload is near complete
        let analysisInterval: any;
        const startAnalysisSim = (startVal: number) => {
          if (analysisInterval) return;
          analysisInterval = setInterval(() => {
            setUploadProgress(prev => {
              if (prev === null) return null;
              if (prev >= 99) {
                clearInterval(analysisInterval);
                return 99;
              }
              // Increment slowly: 0.1% every 500ms
              return prev + 0.1;
            });
          }, 500);
        };

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            // Map 0-100% upload to 10-90% total progress
            const percentComplete = (event.loaded / event.total) * 80;
            const currentProgress = 10 + percentComplete;
            setUploadProgress(currentProgress);
            
            if (currentProgress >= 89) {
              startAnalysisSim(currentProgress);
            }
          }
        };
        
        xhr.onload = () => {
          if (analysisInterval) clearInterval(analysisInterval);
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100);
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (e) {
              reject(new Error('伺服器回傳格式錯誤'));
            }
          } else {
            let errorMessage = '後端分析失敗';
            try {
              const errorData = JSON.parse(xhr.responseText);
              errorMessage = errorData.error || errorMessage;
            } catch (e) {
              errorMessage = `伺服器錯誤 (${xhr.status}): ${xhr.statusText}`;
            }
            reject(new Error(errorMessage));
          }
        };
        
        xhr.onerror = () => {
          if (analysisInterval) clearInterval(analysisInterval);
          reject(new Error('網路連線錯誤'));
        };
        
        xhr.send(JSON.stringify({
          prompt,
          videoData,
          modelName: "gemini-3-flash-preview",
          studentName: user.displayName,
          videoUrl: finalVideoUrl,
          studentUid: user.uid
        }));
      });
      
      if ((!data.transcript || data.transcript.length < 50) && actualTranscript) {
        data.transcript = actualTranscript;
      }

      setResult(data);
      // History is now saved by the backend into SQLite

    } catch (err: any) {
      console.error(err);
      setError('分析失敗，請稍後再試。錯誤訊息：' + (err.message || '未知錯誤'));
    } finally {
      setLoading(false);
      setUploadProgress(null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 pb-20">
      {/* Header */}
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-indigo-600 p-1.5 rounded-lg">
              <Glasses className="w-5 h-5 text-white" />
            </div>
            <h1 className="font-bold text-xl tracking-tight text-zinc-900">驗光實驗步驟驗證系統</h1>
          </div>
          <div className="flex items-center gap-1 bg-zinc-100 p-1 rounded-xl">
            <button 
              onClick={() => setView('student')}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${view === 'student' ? 'bg-white text-indigo-600 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
            >
              學生端
            </button>
            <button 
              onClick={() => setView('history')}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${view === 'history' ? 'bg-white text-indigo-600 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
            >
              歷史紀錄
            </button>
            <button 
              onClick={() => {
                setView('teacher');
                if (!isTeacherLoggedIn && userRole !== 'teacher') {
                  setLoginUsername('');
                  setLoginPassword('');
                  setLoginError('');
                }
              }}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${view === 'teacher' ? 'bg-white text-indigo-600 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'}`}
            >
              教師後台
            </button>
          </div>
          
          <div className="flex items-center gap-4 ml-4 pl-4 border-l border-zinc-200 relative">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="text-right hidden sm:block">
                  <p className="text-xs font-bold text-zinc-900">{user.displayName}</p>
                  <p className="text-[10px] text-zinc-500 uppercase tracking-widest">
                    {userRole === 'teacher' ? '教師' : '學生'}
                    {user.isAnonymous && ' (訪客模式)'}
                  </p>
                </div>
                <button 
                  onClick={handleLogout}
                  className="p-2 hover:bg-zinc-100 rounded-xl transition-colors text-zinc-500"
                  title="登出"
                >
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setIsLoginDropdownOpen(!isLoginDropdownOpen)}
                  className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
                >
                  <LogIn className="w-4 h-4" />
                  登入 / 測試
                </button>
                
                <AnimatePresence>
                  {isLoginDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setIsLoginDropdownOpen(false)} />
                      <motion.div 
                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                        className="absolute right-0 top-full mt-2 w-64 bg-white border border-zinc-200 rounded-2xl shadow-2xl z-30 overflow-hidden p-2"
                      >
                        <button 
                          onClick={() => { handleGoogleLogin(); setIsLoginDropdownOpen(false); }}
                          className="w-full flex items-center gap-3 p-3 hover:bg-zinc-50 rounded-xl transition-all text-left group"
                        >
                          <div className="w-8 h-8 bg-white border border-zinc-200 rounded-lg flex items-center justify-center group-hover:border-indigo-300">
                            <Youtube className="w-4 h-4 text-red-600" />
                          </div>
                          <div>
                            <p className="text-xs font-bold text-zinc-900">Google 帳號登入</p>
                            <p className="text-[10px] text-zinc-400">使用正式帳號</p>
                          </div>
                        </button>
                        
                        <div className="h-px bg-zinc-100 my-2" />
                        
                        <p className="px-3 py-1 text-[10px] font-black text-zinc-400 uppercase tracking-widest">安全性測試模式</p>
                        
                        <button 
                          onClick={() => { handleGuestLogin('student'); setIsLoginDropdownOpen(false); }}
                          className="w-full flex items-center gap-3 p-3 hover:bg-indigo-50 rounded-xl transition-all text-left group"
                        >
                          <div className="w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center text-indigo-600">
                            <UserIcon className="w-4 h-4" />
                          </div>
                          <div>
                            <p className="text-xs font-bold text-indigo-900">訪客測試 (學生)</p>
                            <p className="text-[10px] text-indigo-400">無需帳號，僅供測試</p>
                          </div>
                        </button>
                        
                        <button 
                          onClick={() => { handleGuestLogin('teacher'); setIsLoginDropdownOpen(false); }}
                          className="w-full flex items-center gap-3 p-3 hover:bg-emerald-50 rounded-xl transition-all text-left group"
                        >
                          <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center text-emerald-600">
                            <ShieldCheck className="w-4 h-4" />
                          </div>
                          <div>
                            <p className="text-xs font-bold text-emerald-900">訪客測試 (教師)</p>
                            <p className="text-[10px] text-emerald-400">測試管理後台功能</p>
                          </div>
                        </button>
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 pt-12">
        <AnimatePresence mode="wait">
          {view === 'student' ? (
            <motion.div 
              key="student-view"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="max-w-5xl mx-auto"
            >
              <AnimatePresence mode="wait">
                {loading ? (
                  <motion.div 
                    key="loading-page"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="min-h-[60vh] flex flex-col items-center justify-center"
                  >
                    <div className="bg-white border border-zinc-200 rounded-[3rem] p-16 flex flex-col items-center text-center space-y-10 shadow-2xl max-w-xl w-full">
                      <div className="relative">
                        <div className="w-24 h-24 border-4 border-indigo-50 border-t-indigo-600 rounded-full animate-spin"></div>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <RefreshCw className="w-10 h-10 text-indigo-600 animate-pulse" />
                        </div>
                      </div>
                      <div className="space-y-4">
                        <h3 className="text-2xl font-black text-zinc-900 tracking-tight">
                          {uploadProgress !== null 
                            ? (uploadProgress >= 95 ? "正在進行 AI 專業分析..." : "正在上傳影片...")
                            : transcriptionStatus || '正在讀取影音並轉為文字...'}
                        </h3>
                        <p className="text-zinc-500 text-base leading-relaxed">
                          {uploadProgress !== null 
                            ? (uploadProgress >= 95 
                                ? '影片已成功送達，AI 考官正在仔細審查每一個操作細節，請稍候。' 
                                : '影片正在安全地傳送至雲端伺服器，完成後 AI 將立即開始分析。')
                            : transcriptionStatus 
                              ? '背景處理程序正在運作中，這可能需要一點時間，您可以稍候或查看進度。'
                              : 'AI 正在利用多模態技術分析影片內容，提取對話與操作細節，並與標準步驟進行精確比對。'}
                        </p>
                      </div>
                      {uploadProgress !== null && (
                        <div className="w-full space-y-3">
                          <div className="flex justify-between items-end">
                            <span className="text-xs font-bold text-indigo-600 uppercase tracking-wider">處理進度</span>
                            <span className="text-2xl font-black text-zinc-900 tabular-nums">
                              {Math.round(uploadProgress)}%
                            </span>
                          </div>
                          <div className="w-full bg-zinc-100 h-3 rounded-full overflow-hidden shadow-inner">
                            <motion.div 
                              className="bg-gradient-to-r from-indigo-500 to-indigo-600 h-full"
                              initial={{ width: 0 }}
                              animate={{ width: `${uploadProgress}%` }}
                              transition={{ type: "spring", stiffness: 50, damping: 20 }}
                            />
                          </div>
                        </div>
                      )}
                      <div className="flex gap-2">
                        {[0, 1, 2].map((i) => (
                          <motion.div
                            key={i}
                            animate={{ opacity: [0.3, 1, 0.3] }}
                            transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.2 }}
                            className="w-2 h-2 rounded-full bg-indigo-600"
                          />
                        ))}
                      </div>
                    </div>
                  </motion.div>
                ) : result ? (
                  <motion.div 
                    key="result-page"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="space-y-8"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <div className="bg-indigo-600 p-2 rounded-xl">
                          <Info className="w-5 h-5 text-white" />
                        </div>
                        <h2 className="text-xl font-black text-zinc-900 tracking-tight">驗證結果報告</h2>
                      </div>
                      <button 
                        onClick={handleReset}
                        className="text-sm font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-2 bg-indigo-50 px-5 py-2.5 rounded-2xl transition-all hover:shadow-md active:scale-95"
                      >
                        <RefreshCw className="w-4 h-4" />
                        重新驗證
                      </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                      {/* Result Summary Card */}
                      <div className="lg:col-span-12">
                        <div className={`p-12 rounded-[3rem] border shadow-2xl relative overflow-hidden ${result.score >= 80 ? 'bg-emerald-50 border-emerald-100' : 'bg-orange-50 border-orange-100'}`}>
                          <div className="absolute top-0 right-0 p-12 opacity-10">
                            {result.score >= 80 ? (
                              <CheckCircle2 className="w-48 h-48 text-emerald-600" />
                            ) : (
                              <AlertCircle className="w-48 h-48 text-orange-600" />
                            )}
                          </div>
                          
                          <div className="relative z-10 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
                            <div className="space-y-6">
                              <div>
                                <p className={`text-sm font-black uppercase tracking-widest mb-3 ${result.score >= 80 ? 'text-emerald-600' : 'text-orange-600'}`}>
                                  實驗總體評分
                                </p>
                                <h3 className="text-8xl font-black text-zinc-900 tracking-tighter">
                                  {result.score}<span className="text-3xl font-bold opacity-20 ml-2">/100</span>
                                </h3>
                              </div>
                              <div className="bg-white/70 backdrop-blur-md p-8 rounded-[2rem] border border-white/50 shadow-sm">
                                <p className="text-lg text-zinc-800 leading-relaxed font-bold italic">
                                  "{result.feedback}"
                                </p>
                              </div>
                            </div>

                            <div className="space-y-8">
                              <div className="bg-white/40 p-6 rounded-3xl border border-white/20">
                                <h4 className="text-xs font-black text-zinc-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                                  <Youtube className="w-4 h-4" />
                                  驗證影片來源
                                </h4>
                                <p className="text-sm font-mono text-zinc-600 truncate bg-white/60 p-3 rounded-xl border border-white/40">
                                  {url}
                                </p>
                              </div>
                              <div className="flex gap-4">
                                <div className="flex-1 bg-white/60 p-6 rounded-3xl border border-white/40 text-center">
                                  <p className="text-xs font-bold text-zinc-400 uppercase mb-1">偵測步驟</p>
                                  <p className="text-2xl font-black text-zinc-900">{result.detectedSteps.length}</p>
                                </div>
                                <div className="flex-1 bg-white/60 p-6 rounded-3xl border border-white/40 text-center">
                                  <p className="text-xs font-bold text-zinc-400 uppercase mb-1">遺漏步驟</p>
                                  <p className="text-2xl font-black text-red-600">{result.missingSteps.length}</p>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Detailed Breakdown */}
                      <div className="lg:col-span-7 space-y-8">
                        <div className="bg-white border border-zinc-200 rounded-[2.5rem] p-10 shadow-sm space-y-10">
                          <div>
                            <h4 className="text-sm font-black text-zinc-900 uppercase tracking-widest mb-6 flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
                                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                              </div>
                              影片中偵測到的正確操作
                            </h4>
                            <div className="space-y-4">
                              {result.detectedSteps.map((step, i) => (
                                <motion.div 
                                  initial={{ opacity: 0, x: -10 }}
                                  animate={{ opacity: 1, x: 0 }}
                                  transition={{ delay: i * 0.1 }}
                                  key={i} 
                                  className="flex items-center gap-4 text-base text-zinc-700 font-bold bg-zinc-50 p-5 rounded-2xl border border-zinc-100 group hover:bg-emerald-50 hover:border-emerald-100 transition-all"
                                >
                                  <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-[10px] text-white font-black shadow-lg shadow-emerald-200">
                                    {i + 1}
                                  </div>
                                  {step}
                                </motion.div>
                              ))}
                              {result.detectedSteps.length === 0 && (
                                <div className="text-center py-10 bg-zinc-50 rounded-2xl border border-dashed border-zinc-200">
                                  <p className="text-zinc-400 font-medium">未偵測到明確的標準步驟</p>
                                </div>
                              )}
                            </div>
                          </div>

                          {result.missingSteps.length > 0 && (
                            <div className="pt-10 border-t border-zinc-100">
                              <h4 className="text-sm font-black text-zinc-900 uppercase tracking-widest mb-6 flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center">
                                  <AlertCircle className="w-4 h-4 text-red-600" />
                                </div>
                                遺漏或需要改進的環節
                              </h4>
                              <div className="space-y-4">
                                {result.missingSteps.map((step, i) => (
                                  <motion.div 
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    transition={{ delay: i * 0.1 }}
                                    key={i} 
                                    className="flex items-center gap-4 text-base text-red-600 font-bold bg-red-50 p-5 rounded-2xl border border-red-100"
                                  >
                                    <div className="w-2 h-2 rounded-full bg-red-500" />
                                    {step}
                                  </motion.div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Transcript Sidebar */}
                      <div className="lg:col-span-5">
                        <div className="bg-zinc-900 rounded-[2.5rem] p-10 shadow-2xl h-full flex flex-col border border-zinc-800 relative overflow-hidden">
                          {/* Background Glow */}
                          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500 via-indigo-500 to-purple-500 opacity-50" />
                          
                          <div className="flex items-center justify-between mb-6">
                            <div className="flex items-center gap-2">
                              <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin-slow" />
                              <h4 className="text-xs font-black text-zinc-400 uppercase tracking-widest">影音轉文字紀錄</h4>
                            </div>
                            <div className="flex items-center gap-2">
                              <button 
                                onClick={handleCopyTranscript}
                                className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-white"
                                title="複製文字"
                              >
                                {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                              </button>
                              <button 
                                onClick={handleDownloadTranscript}
                                className="p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-white"
                                title="下載 .txt"
                              >
                                <Download className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          {/* Search Bar */}
                          <div className="relative mb-6">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
                            <input 
                              type="text"
                              placeholder="搜尋關鍵字..."
                              value={searchTerm}
                              onChange={(e) => setSearchTerm(e.target.value)}
                              className="w-full bg-zinc-800/50 border border-zinc-700/50 rounded-xl pl-9 pr-4 py-2 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
                            />
                          </div>

                          <div className="flex-1 bg-zinc-800/30 rounded-2xl p-6 text-sm text-zinc-300 leading-relaxed overflow-y-auto font-mono selection:bg-emerald-500/30 selection:text-white scrollbar-thin scrollbar-thumb-zinc-700">
                            {result.transcript ? result.transcript.split('\n').filter(line => line.toLowerCase().includes(searchTerm.toLowerCase())).map((line, i) => (
                              <p key={i} className="mb-2 hover:text-white transition-colors cursor-default group flex gap-3">
                                <span className="text-zinc-600 select-none group-hover:text-emerald-500/50 transition-colors">
                                  {line.match(/^\[\d+:\d+\]/) ? line.match(/^\[\d+:\d+\]/)?.[0] : ''}
                                </span>
                                <span className="flex-1">
                                  {line.replace(/^\[\d+:\d+\]\s*/, '')}
                                </span>
                              </p>
                            )) : "無語音紀錄"}
                          </div>
                          
                          <div className="mt-6 pt-6 border-t border-zinc-800 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-tighter">
                                影音辨識完成
                              </p>
                            </div>
                            <p className="text-[10px] text-zinc-600 font-medium">
                              {result.transcript ? `${result.transcript.length} 字元` : '0 字元'}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div 
                    key="input-page"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    className="max-w-2xl mx-auto pt-10 space-y-12"
                  >
                    <div className="text-center space-y-4 mb-12">
                      <motion.div 
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.2 }}
                        className="inline-flex items-center justify-center w-20 h-20 bg-indigo-50 rounded-3xl mb-4"
                      >
                        <PlusCircle className="w-10 h-10 text-indigo-600" />
                      </motion.div>
                      <h2 className="text-4xl font-black text-zinc-900 tracking-tight">開始您的實驗驗證</h2>
                      <p className="text-zinc-500 max-w-md mx-auto leading-relaxed text-lg">
                        請提供您的 YouTube 影片連結並選擇對應的操作步驟，系統將為您進行即時的 AI 專業分析。
                      </p>
                    </div>

                    <div className="space-y-8">
                      <section className="space-y-4">
                        <div className="flex items-center gap-2 text-zinc-500 mb-2">
                          <Youtube className="w-5 h-5" />
                          <h2 className="text-sm font-semibold uppercase tracking-wider">影片來源</h2>
                        </div>
                        <div className="bg-white p-8 rounded-[2.5rem] border border-zinc-200 shadow-sm space-y-6 transition-all hover:shadow-md">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-3">
                              <label className="text-xs font-black text-zinc-400 uppercase tracking-widest">YouTube 連結</label>
                              <div className="flex gap-2">
                                <input 
                                  type="text" 
                                  value={url}
                                  onChange={(e) => { setUrl(e.target.value); setVideoFile(null); }}
                                  placeholder="貼上 YouTube 連結..."
                                  className="flex-1 bg-zinc-50 border border-zinc-200 rounded-2xl px-5 py-3.5 text-sm focus:outline-none focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 transition-all font-medium"
                                />
                              </div>
                            </div>
                            <div className="space-y-3">
                              <label className="text-xs font-black text-zinc-400 uppercase tracking-widest">上傳影片檔案</label>
                              <div 
                                onClick={() => fileInputRef.current?.click()}
                                className={`flex items-center justify-center gap-3 border-2 border-dashed rounded-2xl p-3.5 cursor-pointer transition-all ${videoFile ? 'bg-indigo-50 border-indigo-300 text-indigo-600' : 'bg-zinc-50 border-zinc-200 text-zinc-500 hover:border-indigo-400'}`}
                              >
                                <Upload className="w-5 h-5" />
                                <span className="text-sm font-bold truncate">
                                  {videoFile ? videoFile.name : '選擇影片檔案...'}
                                </span>
                                <input 
                                  type="file"
                                  ref={fileInputRef}
                                  onChange={handleFileSelect}
                                  accept="video/*"
                                  className="hidden"
                                />
                              </div>
                            </div>
                          </div>

                          <button 
                            onClick={handleVerify}
                            disabled={loading || (!url.trim() && !videoFile)}
                            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white py-4.5 rounded-2xl font-bold text-base transition-all shadow-xl shadow-indigo-200 flex items-center justify-center gap-2 active:scale-95"
                          >
                            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
                            開始 AI 專業驗證
                          </button>

                          {error && (
                            <motion.div 
                              initial={{ opacity: 0, y: -10 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="flex items-center gap-3 text-red-600 text-sm bg-red-50 p-5 rounded-2xl border border-red-100"
                            >
                              <AlertCircle className="w-5 h-5" />
                              {error}
                            </motion.div>
                          )}
                        </div>
                      </section>

                      <section className="space-y-4">
                        <div className="flex items-center justify-between gap-2 text-zinc-500 mb-2">
                          <div className="flex items-center gap-2">
                            <ClipboardCheck className="w-5 h-5" />
                            <h2 className="text-sm font-semibold uppercase tracking-wider">操作環節</h2>
                          </div>
                        </div>
                        
                        <div className="relative">
                          <button 
                            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                            className="w-full bg-white border border-zinc-200 rounded-[2rem] px-6 py-5 text-base flex items-center justify-between hover:border-indigo-500 transition-all shadow-sm group"
                          >
                            <span className="text-zinc-600 font-bold truncate">
                              {selectedSteps.length === 0 
                                ? "請選擇要驗證的步驟..." 
                                : selectedSteps.length === standardSteps.length 
                                  ? "已選擇全部步驟" 
                                  : `已選擇 ${selectedSteps.length} 個步驟`}
                            </span>
                            <div className="flex items-center gap-3">
                              {selectedSteps.length > 0 && (
                                <span className="bg-indigo-100 text-indigo-700 text-xs font-black px-3 py-1 rounded-full">
                                  {selectedSteps.length}
                                </span>
                              )}
                              <ArrowRight className={`w-5 h-5 transition-transform group-hover:translate-x-1 ${isDropdownOpen ? 'rotate-90' : ''}`} />
                            </div>
                          </button>

                          <AnimatePresence>
                            {isDropdownOpen && (
                              <>
                                <div 
                                  className="fixed inset-0 z-20" 
                                  onClick={() => setIsDropdownOpen(false)} 
                                />
                                <motion.div 
                                  initial={{ opacity: 0, y: 10 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  exit={{ opacity: 0, y: 10 }}
                                  className="absolute left-0 right-0 mt-4 bg-white border border-zinc-200 rounded-[2.5rem] shadow-2xl z-30 overflow-hidden max-h-96 overflow-y-auto"
                                >
                                  <div className="p-4 border-b border-zinc-100 bg-zinc-50 flex justify-between gap-3 sticky top-0 z-10">
                                    <button 
                                      onClick={(e) => { e.stopPropagation(); setSelectedSteps(standardSteps.map(s => s.title)); }}
                                      className="flex-1 text-xs font-black uppercase tracking-widest bg-white border border-zinc-200 hover:bg-zinc-100 text-zinc-600 px-4 py-3 rounded-xl transition-colors"
                                    >
                                      全選
                                    </button>
                                    <button 
                                      onClick={(e) => { e.stopPropagation(); setSelectedSteps([]); }}
                                      className="flex-1 text-xs font-black uppercase tracking-widest bg-white border border-zinc-200 hover:bg-zinc-100 text-zinc-600 px-4 py-3 rounded-xl transition-colors"
                                    >
                                      清除
                                    </button>
                                  </div>
                                  <div className="p-2">
                                    {standardSteps.map((step, index) => {
                                      const isSelected = selectedSteps.includes(step.title);
                                      return (
                                        <div 
                                          key={index} 
                                          onClick={(e) => { e.stopPropagation(); toggleStep(step.title); }}
                                          className={`flex items-center gap-4 p-5 rounded-2xl cursor-pointer transition-all mb-1 last:mb-0 ${isSelected ? 'bg-indigo-50/50' : 'hover:bg-zinc-50'}`}
                                        >
                                          <div className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-zinc-300'}`}>
                                            {isSelected && <CheckCircle2 className="w-4 h-4 text-white" />}
                                          </div>
                                          <span className="text-xs font-black text-zinc-400 w-6">{index + 1}</span>
                                          <span className={`text-base font-bold transition-colors ${isSelected ? 'text-indigo-900' : 'text-zinc-700'}`}>
                                            {step.title}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </motion.div>
                              </>
                            )}
                          </AnimatePresence>
                        </div>
                      </section>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ) : view === 'history' ? (
            <motion.div 
              key="history-view"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="max-w-4xl mx-auto space-y-8"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="bg-indigo-600 p-2 rounded-xl">
                    <History className="w-5 h-5 text-white" />
                  </div>
                  <h2 className="text-2xl font-black text-zinc-900 tracking-tight">驗證歷史紀錄</h2>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4">
                {submissions.length === 0 ? (
                  <div className="text-center py-20 bg-white rounded-[2.5rem] border border-zinc-200">
                    <p className="text-zinc-400 font-bold">尚無任何驗證紀錄</p>
                  </div>
                ) : (
                  submissions.map((sub) => (
                    <div 
                      key={sub.id}
                      className="bg-white p-6 rounded-3xl border border-zinc-200 hover:border-indigo-300 transition-all shadow-sm group cursor-pointer"
                      onClick={() => {
                        setResult(sub.result);
                        setUrl(sub.videoUrl);
                        setView('student');
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${sub.result.score >= 80 ? 'bg-emerald-50 text-emerald-600' : 'bg-orange-50 text-orange-600'}`}>
                            <span className="text-lg font-black">{sub.result.score}</span>
                          </div>
                          <div>
                            <p className="font-bold text-zinc-900 truncate max-w-xs">{sub.videoUrl}</p>
                            <p className="text-xs text-zinc-500">
                              {sub.createdAt?.toDate ? sub.createdAt.toDate().toLocaleString() : '剛剛'}
                              {userRole === 'teacher' && ` • 學生：${sub.studentName || '未知'}`}
                            </p>
                          </div>
                        </div>
                        <ArrowRight className="w-5 h-5 text-zinc-300 group-hover:text-indigo-600 group-hover:translate-x-1 transition-all" />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="teacher-view"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-8"
            >
              {!isTeacherLoggedIn && userRole !== 'teacher' ? (
                <div className="max-w-md mx-auto pt-12">
                  <div className="bg-white p-8 rounded-[2.5rem] border border-zinc-200 shadow-sm space-y-6">
                    <div className="text-center space-y-2">
                      <div className="bg-indigo-50 w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <ShieldCheck className="w-6 h-6 text-indigo-600" />
                      </div>
                      <h2 className="text-xl font-bold text-zinc-900">教師後台登入</h2>
                      <p className="text-sm text-zinc-500">請輸入帳號密碼以進入管理介面</p>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">帳號</label>
                        <input 
                          type="text"
                          value={loginUsername}
                          onChange={(e) => setLoginUsername(e.target.value)}
                          className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                          placeholder="請輸入帳號"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">密碼</label>
                        <input 
                          type="password"
                          value={loginPassword}
                          onChange={(e) => setLoginPassword(e.target.value)}
                          className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                          placeholder="請輸入密碼"
                        />
                      </div>

                      {loginError && (
                        <div className="bg-red-50 text-red-600 text-xs font-bold p-3 rounded-xl border border-red-100 flex items-center gap-2">
                          <AlertCircle className="w-4 h-4" />
                          {loginError}
                        </div>
                      )}

                      <button 
                        type="submit"
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-2xl shadow-lg shadow-indigo-200 transition-all active:scale-[0.98]"
                      >
                        登入
                      </button>
                    </form>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-2 text-zinc-500">
                      <ShieldCheck className="w-5 h-5" />
                      <h2 className="text-sm font-semibold uppercase tracking-wider">教師後台 - 實驗步驟管理</h2>
                    </div>
                    <button 
                      onClick={() => setIsTeacherLoggedIn(false)}
                      className="text-xs font-bold text-zinc-400 hover:text-red-500 transition-colors"
                    >
                      登出系統
                    </button>
                  </div>

                  <div className="max-w-3xl mx-auto space-y-6">
                    <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-sm space-y-6">
                      <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                          <h3 className="font-bold text-xl text-zinc-900 flex items-center gap-2">
                            <ClipboardCheck className="w-6 h-6 text-indigo-600" />
                            當前步驟與正確答案校正
                          </h3>
                          <p className="text-zinc-500 text-sm">
                            您可以拖動左側圖示來調整步驟順序，或點擊右側圖示進行編輯與刪除。
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={addNewStep}
                            className="flex items-center gap-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 px-4 py-2 rounded-xl text-sm font-bold transition-colors"
                          >
                            <Plus className="w-4 h-4" />
                            新增步驟
                          </button>
                          <button 
                            onClick={checkConfiguration}
                            className="flex items-center gap-1.5 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 px-4 py-2 rounded-xl text-sm font-bold transition-colors"
                          >
                            <Check className="w-4 h-4" />
                            檢查配置
                          </button>
                        </div>
                      </div>

                      <div className="space-y-3 pt-4">
                        <DndContext 
                          sensors={sensors}
                          collisionDetection={closestCenter}
                          onDragEnd={handleDragEnd}
                        >
                          <SortableContext 
                            items={standardSteps.map(s => s.id)}
                            strategy={verticalListSortingStrategy}
                          >
                            {standardSteps.map((step, index) => (
                              <SortableStepItem 
                                key={step.id}
                                step={step}
                                index={index}
                                isEditing={editingStepIndex === index}
                                onToggle={() => setEditingStepIndex(editingStepIndex === index ? null : index)}
                                onUpdateAnswer={(answer) => updateStepAnswer(index, answer)}
                                onDelete={() => deleteStep(index)}
                                onUpdateTitle={(newTitle) => {
                                  const newSteps = [...standardSteps];
                                  newSteps[index] = { ...newSteps[index], title: newTitle };
                                  setStandardSteps(newSteps);
                                }}
                              />
                            ))}
                          </SortableContext>
                        </DndContext>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="max-w-5xl mx-auto px-6 py-12 border-t border-zinc-200 mt-12 text-center">
        <p className="text-zinc-400 text-sm font-medium">
          © {new Date().getFullYear()} 驗光實驗步驟驗證系統 | 網站開發：陳慶儒
        </p>
      </footer>
    </div>
  );
}
