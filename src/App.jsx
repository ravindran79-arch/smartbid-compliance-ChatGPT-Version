import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { 
    FileUp, Send, Loader2, AlertTriangle, CheckCircle, List, FileText, BarChart2,
    Save, Clock, Zap, ArrowLeft, Users, Briefcase, Layers, UserPlus, LogIn, Tag,
    Shield, User, HardDrive, Phone, Mail, Building, Trash2, XCircle, Settings, ClipboardList
} from 'lucide-react'; 

// --- FIREBASE IMPORTS ---
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { 
    getFirestore, collection, addDoc, onSnapshot, query, doc, setDoc, updateDoc, 
    runTransaction, deleteDoc, getDocs, getDoc // ADDED getDoc
} from 'firebase/firestore'; 

// --- CONSTANTS ---
const API_MODEL = "gemini-2.5-flash-preview-09-2025";
const API_KEY = import.meta.env.VITE_API_KEY;
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${API_MODEL}:generateContent?key=${API_KEY}`;

// --- ENUM for Compliance Category ---
const CATEGORY_ENUM = ["LEGAL", "FINANCIAL", "TECHNICAL", "TIMELINE", "REPORTING", "ADMINISTRATIVE", "OTHER"];

// --- APP ROUTING ENUM (RBAC Enabled) ---
const PAGE = {
    HOME: 'HOME',
    COMPLIANCE_CHECK: 'COMPLIANCE_CHECK',
    HISTORY: 'HISTORY',
    ADMIN_DASHBOARD: 'ADMIN_DASHBOARD',
    AUTH: 'AUTH',
};

// --- Helper Functions ---

/**
 * Parses the raw LLM response string into structured JSON data.
 * The model is instructed to return a JSON string in its response.
 * @param {string} rawText The text response from the Gemini API.
 * @returns {object | null} The parsed compliance report object.
 */
const parseGeminiResponse = (rawText) => {
    try {
        // Find the JSON block, which is usually enclosed in triple backticks
        const jsonMatch = rawText.match(/```json\n([\s\S]*?)\n```/);
        
        if (jsonMatch && jsonMatch[1]) {
            const jsonString = jsonMatch[1].trim();
            // Clean up any common trailing or leading non-JSON text
            let cleanedJsonString = jsonString;

            // Attempt to parse
            return JSON.parse(cleanedJsonString);
        }

        // Fallback: Attempt to parse the whole string if no code block marker is found
        return JSON.parse(rawText);

    } catch (error) {
        console.error("Failed to parse Gemini JSON response:", error);
        return null;
    }
};

/**
 * Handles the fetch request to the Gemini API with exponential backoff.
 * @param {object} payload - The API request payload.
 * @returns {Promise<object | null>} The parsed response JSON or null on failure.
 */
const fetchWithBackoff = async (payload) => {
    const maxRetries = 5;
    let delay = 1000; // 1 second

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                const result = await response.json();
                const candidate = result.candidates?.[0];

                if (candidate && candidate.content?.parts?.[0]?.text) {
                    return candidate.content.parts[0].text;
                }
                return null;
            } else if (response.status === 429) {
                // Too Many Requests, proceed to retry
                throw new Error('Rate limit exceeded');
            } else {
                // Other non-retryable errors
                console.error(`API Error: ${response.status} ${response.statusText}`);
                return null;
            }
        } catch (error) {
            if (i === maxRetries - 1) {
                console.error("Max retries reached. Request failed:", error);
                return null;
            }
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // Exponential backoff
        }
    }
    return null;
};

// --- ErrorBoundary Component (Mandatory for robust React apps) ---
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        this.setState({
            error: error,
            errorInfo: errorInfo
        });
        console.error("Uncaught Error in Component:", error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col items-center justify-center min-h-screen bg-red-50 p-4">
                    <AlertTriangle className="w-16 h-16 text-red-600 mb-4" />
                    <h1 className="text-2xl font-bold text-red-800 mb-2">Something Went Wrong</h1>
                    <p className="text-red-700 text-center mb-4">
                        We encountered an error in the application. Please try refreshing.
                    </p>
                    {/* Optional: Show error details for debugging */}
                    <details className="text-sm text-gray-600 bg-red-100 p-3 rounded-lg w-full max-w-md">
                        <summary className="cursor-pointer font-semibold text-red-700">Error Details</summary>
                        <pre className="mt-2 whitespace-pre-wrap break-all p-2 bg-white rounded-md overflow-auto max-h-60">
                            {this.state.error && this.state.error.toString()}
                            <br />
                            {this.state.errorInfo && this.state.errorInfo.componentStack}
                        </pre>
                    </details>
                </div>
            );
        }
        return this.props.children;
    }
}


// --- MAIN APP COMPONENT ---
function App() {
    // --- State Management ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [currentUser, setCurrentUser] = useState(null); // { uid, role, ... }
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [currentPage, setCurrentPage] = useState(PAGE.HOME);

    // Document State
    const [rfqName, setRfqName] = useState('');
    const [bidName, setBidName] = useState('');
    const [rfqText, setRfqText] = useState('');
    const [bidResponseText, setBidResponseText] = useState('');
    
    // UI State
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');

    // Compliance Report State
    const [report, setReport] = useState(null); // The generated compliance report object
    const [reportId, setReportId] = useState(null); // Firestore ID of the current report
    const [savedReports, setSavedReports] = useState([]); // List of user's saved reports
    const [complianceCheckInitiated, setComplianceCheckInitiated] = useState(false); // Tracks if a check was ever started

    // Admin State
    const [adminUserList, setAdminUserList] = useState([]);
    const [adminAllReports, setAdminAllReports] = useState([]);

    // --- EFFECT 1: Firebase Initialization and Auth ---
    useEffect(() => {
      try {
        const firebaseConfig = {
          apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
          authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
          projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
          storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
          messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
          appId: import.meta.env.VITE_FIREBASE_APP_ID
        };

        const hasConfig = Object.values(firebaseConfig).some(v => v);
        if (!hasConfig) {
          console.warn("Firebase config missing — skipping initialization.");
          setIsAuthReady(true);
          return;
        }

        const app = initializeApp(firebaseConfig);
        const newAuth = getAuth(app);
        const newDb = getFirestore(app);

        setDb(newDb);
        setAuth(newAuth);

        const initialAuthToken = typeof __initial_auth_token !== "undefined" ? __initial_auth_token : null;

        const signIn = async () => {
          try {
            if (initialAuthToken) {
              await signInWithCustomToken(newAuth, initialAuthToken);
            } else {
              await signInAnonymously(newAuth);
            }
          } catch (error) {
            console.error("Sign-in failed:", error);
          }
        };

        const unsubscribe = onAuthStateChanged(newAuth, async (user) => {
          const uid = user?.uid || null;
          setUserId(uid);
          setIsAuthReady(true);

          if (uid && newDb) {
            try {
              const docRef = doc(newDb, "users", uid);
              const userDoc = await getDoc(docRef);

              if (userDoc.exists()) {
                setCurrentUser({ uid, ...userDoc.data() });
              } else {
                setCurrentUser({ uid, role: "ANONYMOUS" });
              }
            } catch (e) {
              console.error("Error loading user profile:", e);
            }
          } else {
            setCurrentUser(null);
          }
        });

        signIn();
        return () => unsubscribe();

      } catch (e) {
        console.error("Error initializing Firebase:", e);
        setIsAuthReady(true);
      }
    }, []);

    // --- EFFECT 2: Fetch User's Saved Reports (Public Path: /artifacts/{appId}/public/data/reports/{docId}) ---
    useEffect(() => {
        if (!db || !isAuthReady) return;

        // Use the public path for collaborative reports
        // NOTE: Using a constant app ID for demo purposes if not provided
        const currentAppId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const reportsColRef = collection(db, 'artifacts', currentAppId, 'public', 'data', 'reports');

        const q = query(reportsColRef);

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const reportsData = snapshot.docs.map(d => ({
                id: d.id,
                ...d.data(),
                createdAt: d.data().createdAt?.toDate ? d.data().createdAt.toDate() : new Date(d.data().createdAt)
            })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); // Sort by newest first
            setSavedReports(reportsData);
        }, (err) => {
            console.error("Error fetching saved reports:", err);
            // Non-fatal error, display warning but continue
        });

        return () => unsubscribe();
    }, [db, isAuthReady]);


    // --- Core Compliance Logic ---

    const generateComplianceReport = useCallback(async (rfq, bid, rfqName, bidName) => {
        setIsLoading(true);
        setError('');
        setSuccessMessage('');
        setReport(null);
        setComplianceCheckInitiated(true);

        const systemPrompt = `You are a world-class Smart Bid Compliance Analyst. Your task is to analyze an RFQ (Request for Quotation) and a corresponding Bid Response.
        
        Analyze the Bid Response against the RFQ to determine the compliance status for each key requirement.
        
        Your output MUST be a single, raw JSON object, without any surrounding text, explanations, or markdown fences (i.e., NO \`\`\`json\n...\n\`\`\`).
        
        The JSON structure MUST be:
        {
          "report_summary": {
            "overall_status": "COMPLIANT" | "PARTIALLY_COMPLIANT" | "NON_COMPLIANT",
            "compliance_percentage": number, // 0 to 100
            "summary_recommendation": "string" // A brief recommendation (e.g., "The bid is generally compliant but requires clarification on the legal clause regarding indemnification.")
          },
          "compliance_items": [
            {
              "id": number, // A unique ID for the item (1, 2, 3, ...)
              "rfq_requirement_summary": "string", // A concise summary of the specific requirement from the RFQ
              "bid_response_excerpt": "string", // The exact or paraphrased text from the Bid Response that addresses the requirement
              "compliance_status": "COMPLIANT" | "PARTIALLY_COMPLIANT" | "NON_COMPLIANT" | "N/A", // The status based on the analysis
              "justification": "string", // Detailed explanation for the status
              "category": "LEGAL" | "FINANCIAL" | "TECHNICAL" | "TIMELINE" | "REPORTING" | "ADMINISTRATIVE" | "OTHER" // Select from the predefined list
            }
            // ... potentially 10-20 items in a full report
          ]
        }
        
        Instructions:
        1. Identify at least 10 critical requirements across the RFQ text.
        2. Match each requirement to the Bid Response text.
        3. Assign a status and provide a clear justification.
        4. Populate the 'report_summary' object accurately based on the findings.
        5. Ensure all string values in the JSON are correctly escaped if necessary, but remember the final output MUST be raw JSON text only.
        `;

        const userQuery = `
        RFQ Name: ${rfqName}
        Bid Name: ${bidName}

        --- RFQ CONTENT ---
        ${rfq}
        
        --- BID RESPONSE CONTENT ---
        ${bid}
        
        Please generate the compliance report based on the system instructions.
        `;

        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        report_summary: {
                            type: "OBJECT",
                            properties: {
                                overall_status: { type: "STRING" },
                                compliance_percentage: { type: "NUMBER" },
                                summary_recommendation: { type: "STRING" }
                            }
                        },
                        compliance_items: {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    id: { type: "NUMBER" },
                                    rfq_requirement_summary: { type: "STRING" },
                                    bid_response_excerpt: { type: "STRING" },
                                    compliance_status: { type: "STRING" },
                                    justification: { type: "STRING" },
                                    category: { type: "STRING" }
                                }
                            }
                        }
                    }
                }
            }
        };

        try {
            const rawResponseText = await fetchWithBackoff(payload);
            
            if (rawResponseText) {
                // The API call with responseSchema *should* return the raw JSON text directly
                const reportObject = JSON.parse(rawResponseText);
                setReport(reportObject);
                setReportId(null); // New report, no ID yet
                setSuccessMessage("Compliance report generated successfully!");
            } else {
                setError("Failed to generate report. The API returned an empty or invalid response.");
            }
        } catch (e) {
            console.error("Error during report generation or JSON parsing:", e);
            setError("An error occurred during processing. Please check the console for details.");
        } finally {
            setIsLoading(false);
        }
    }, [rfqName, bidName]); // Dependency on names for the prompt

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!rfqText.trim() || !bidResponseText.trim() || !rfqName.trim() || !bidName.trim()) {
            setError("All fields (RFQ Name, Bid Name, RFQ Text, Bid Response Text) must be filled out.");
            return;
        }
        setError('');
        generateComplianceReport(rfqText, bidResponseText, rfqName, bidName);
    };

    const handleSaveReport = useCallback(async () => {
        if (!db || !userId || !report) {
            setError("Cannot save: Database not ready or report missing.");
            return;
        }

        setIsLoading(true);
        setError('');
        setSuccessMessage('');

        const currentAppId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

        const newReport = {
            rfqName,
            bidName,
            rfqText,
            bidResponseText,
            reportData: report, // Store the structured JSON object
            userId: userId,
            userName: currentUser?.email || 'Anonymous User',
            createdAt: new Date(),
        };

        try {
            // Use the public path for collaborative reports
            const reportsColRef = collection(db, 'artifacts', currentAppId, 'public', 'data', 'reports');

            if (reportId) {
                // Update existing report
                const docRef = doc(reportsColRef, reportId);
                await updateDoc(docRef, newReport);
                setSuccessMessage(`Report "${rfqName} / ${bidName}" updated successfully!`);
            } else {
                // Save new report
                const docRef = await addDoc(reportsColRef, newReport);
                setReportId(docRef.id);
                setSuccessMessage(`New report "${rfqName} / ${bidName}" saved successfully!`);
            }
        } catch (e) {
            console.error("Error saving report:", e);
            setError("Failed to save the report to the database.");
        } finally {
            setIsLoading(false);
        }
    }, [db, userId, report, rfqName, bidName, reportId, currentUser]);

    const loadReport = useCallback((report) => {
        setRfqName(report.rfqName);
        setBidName(report.bidName);
        setRfqText(report.rfqText);
        setBidResponseText(report.bidResponseText);
        setReport(report.reportData);
        setReportId(report.id);
        setComplianceCheckInitiated(true);
        setCurrentPage(PAGE.COMPLIANCE_CHECK);
        setSuccessMessage(`Report loaded: ${report.rfqName} / ${report.bidName}`);
    }, []);

    const deleteReport = useCallback(async (id, rfq, bid) => {
        if (!db) {
            setError("Database not ready.");
            return;
        }
        if (!window.confirm(`Are you sure you want to permanently delete the report: ${rfq} / ${bid}?`)) {
            return;
        }

        setIsLoading(true);
        setError('');
        setSuccessMessage('');

        const currentAppId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

        try {
            // Use the public path for collaborative reports
            const reportsColRef = collection(db, 'artifacts', currentAppId, 'public', 'data', 'reports');
            const docRef = doc(reportsColRef, id);
            await deleteDoc(docRef);

            // Clear current state if the deleted report was the one currently loaded
            if (reportId === id) {
                setRfqName('');
                setBidName('');
                setRfqText('');
                setBidResponseText('');
                setReport(null);
                setReportId(null);
            }

            setSuccessMessage(`Report "${rfq} / ${bid}" deleted successfully.`);
        } catch (e) {
            console.error("Error deleting report:", e);
            setError("Failed to delete the report.");
        } finally {
            setIsLoading(false);
        }
    }, [db, reportId]);

    // --- Admin Dashboard Logic ---

    // Effect to fetch all users (Admin only)
    useEffect(() => {
        if (!db || currentUser?.role !== 'ADMIN' || currentPage !== PAGE.ADMIN_DASHBOARD) return;

        const usersColRef = collection(db, 'users');
        const unsubscribe = onSnapshot(usersColRef, (snapshot) => {
            const users = snapshot.docs.map(d => ({
                uid: d.id,
                ...d.data()
            }));
            setAdminUserList(users);
        }, (err) => {
            console.error("Error fetching admin user list:", err);
        });

        return () => unsubscribe();
    }, [db, currentUser, currentPage]);

    // Effect to fetch all reports (Admin only - redundant with savedReports, but good for dedicated admin view)
    useEffect(() => {
        if (!db || currentUser?.role !== 'ADMIN' || currentPage !== PAGE.ADMIN_DASHBOARD) return;

        const currentAppId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const reportsColRef = collection(db, 'artifacts', currentAppId, 'public', 'data', 'reports');
        const unsubscribe = onSnapshot(reportsColRef, (snapshot) => {
            const reportsData = snapshot.docs.map(d => ({
                id: d.id,
                ...d.data(),
                createdAt: d.data().createdAt?.toDate ? d.data().createdAt.toDate() : new Date(d.data().createdAt)
            })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); // Sort by newest first
            setAdminAllReports(reportsData);
        }, (err) => {
            console.error("Error fetching all reports for admin:", err);
        });

        return () => unsubscribe();
    }, [db, currentUser, currentPage]);

    const updateUserRole = useCallback(async (uid, newRole) => {
        if (!db || currentUser?.role !== 'ADMIN') return;

        setIsLoading(true);
        setError('');

        try {
            const docRef = doc(db, 'users', uid);
            await updateDoc(docRef, { role: newRole });
            setSuccessMessage(`User ${uid} role updated to ${newRole}`);
        } catch (e) {
            console.error("Error updating user role:", e);
            setError("Failed to update user role.");
        } finally {
            setIsLoading(false);
        }
    }, [db, currentUser]);

    // --- Components / UI Helpers ---

    const StatusBadge = ({ status }) => {
        let color = 'bg-gray-200 text-gray-800';
        let icon = <Tag className="w-3 h-3 mr-1" />;

        switch (status) {
            case 'COMPLIANT':
                color = 'bg-green-100 text-green-800';
                icon = <CheckCircle className="w-3 h-3 mr-1" />;
                break;
            case 'PARTIALLY_COMPLIANT':
                color = 'bg-amber-100 text-amber-800';
                icon = <AlertTriangle className="w-3 h-3 mr-1" />;
                break;
            case 'NON_COMPLIANT':
                color = 'bg-red-100 text-red-800';
                icon = <XCircle className="w-3 h-3 mr-1" />;
                break;
            case 'N/A':
                color = 'bg-slate-100 text-slate-500';
                icon = <Tag className="w-3 h-3 mr-1" />;
                break;
            default:
                break;
        }

        return (
            <span className={`inline-flex items-center px-3 py-1 text-xs font-semibold rounded-full ${color}`}>
                {icon}
                {status.replace(/_/g, ' ')}
            </span>
        );
    };

    const ComplianceReportView = () => {
        if (!complianceCheckInitiated) {
            return (
                <div className="flex flex-col items-center justify-center p-8 bg-slate-50 border border-slate-200 rounded-xl">
                    <ClipboardList className="w-12 h-12 text-slate-400 mb-3" />
                    <p className="text-lg font-semibold text-slate-700">No Analysis Run Yet</p>
                    <p className="text-slate-500">Enter RFQ and Bid details and press "Check Compliance" to generate the report.</p>
                </div>
            );
        }

        if (isLoading) {
            return (
                <div className="flex flex-col items-center justify-center p-8">
                    <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
                    <p className="mt-2 text-slate-600 font-medium">Generating detailed report...</p>
                </div>
            );
        }

        if (!report) {
            return (
                <div className="flex flex-col items-center justify-center p-8 bg-red-50 border border-red-200 rounded-xl">
                    <XCircle className="w-12 h-12 text-red-600 mb-3" />
                    <p className="text-lg font-semibold text-red-700">Report Generation Failed</p>
                    <p className="text-red-500">Please check the input texts or retry the submission.</p>
                    {error && <p className="mt-2 text-sm text-red-600">Error: {error}</p>}
                </div>
            );
        }

        const summary = report.report_summary || {};
        const items = report.compliance_items || [];

        return (
            <div className="space-y-6">
                {/* Header and Save Button */}
                <div className="flex justify-between items-center pb-4 border-b border-slate-200">
                    <h2 className="text-2xl font-bold text-slate-800">Compliance Report: {rfqName} / {bidName}</h2>
                    <button
                        onClick={handleSaveReport}
                        className="flex items-center px-5 py-2 text-sm font-semibold rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 transition shadow-lg"
                        title={reportId ? "Update existing report" : "Save report to history"}
                    >
                        <Save className="w-4 h-4 mr-2" />
                        {reportId ? 'Update Report' : 'Save Report'}
                    </button>
                </div>
                
                {/* Summary Card */}
                <div className="bg-white p-6 rounded-xl shadow-lg border border-slate-100">
                    <h3 className="text-xl font-semibold mb-3 text-slate-700 flex items-center">
                        <BarChart2 className="w-5 h-5 mr-2 text-amber-500" /> Overall Summary
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center border-b pb-4 mb-4">
                        <div>
                            <p className="text-sm text-slate-500">Status</p>
                            <StatusBadge status={summary.overall_status || 'N/A'} />
                        </div>
                        <div>
                            <p className="text-sm text-slate-500">Compliance Score</p>
                            <p className="text-3xl font-bold text-indigo-600 mt-1">{summary.compliance_percentage || 0}%</p>
                        </div>
                        <div>
                            <p className="text-sm text-slate-500">Items Checked</p>
                            <p className="text-3xl font-bold text-slate-600 mt-1">{items.length}</p>
                        </div>
                    </div>
                    <div>
                        <p className="text-md font-semibold text-slate-700 mb-1">Analyst Recommendation:</p>
                        <p className="text-slate-600 italic bg-slate-50 p-3 rounded-lg border border-slate-200">{summary.summary_recommendation || 'No recommendation provided.'}</p>
                    </div>
                </div>

                {/* Detailed Compliance Items */}
                <h3 className="text-xl font-bold text-slate-800 flex items-center pt-4 border-t border-slate-200">
                    <List className="w-5 h-5 mr-2 text-amber-500" /> Detailed Compliance Items
                </h3>
                <div className="space-y-4">
                    {items.map((item, index) => (
                        <div key={item.id || index} className="bg-white p-5 rounded-xl shadow-md border border-slate-100 hover:shadow-lg transition">
                            <div className="flex justify-between items-start mb-3">
                                <h4 className="text-lg font-semibold text-slate-700 flex items-center">
                                    <span className="bg-indigo-100 text-indigo-600 w-6 h-6 flex items-center justify-center rounded-full mr-2 text-sm">{item.id || index + 1}</span>
                                    {item.rfq_requirement_summary}
                                </h4>
                                <div className="flex space-x-2">
                                    <StatusBadge status={item.compliance_status} />
                                    <span className="px-3 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-600">{item.category}</span>
                                </div>
                            </div>

                            <div className="space-y-2 text-sm">
                                <p className="text-slate-500">
                                    <span className="font-semibold text-slate-700">Bid Excerpt:</span> {item.bid_response_excerpt}
                                </p>
                                <p className="bg-slate-50 p-3 rounded-lg text-slate-700 border border-slate-200">
                                    <span className="font-semibold text-slate-800">Justification:</span> {item.justification}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    const ComplianceCheckPage = () => (
        <div className="flex flex-col lg:flex-row gap-6 p-4">
            {/* Left Column: Input Forms */}
            <div className="w-full lg:w-1/3 space-y-4">
                <h1 className="text-3xl font-extrabold text-slate-800 mb-4 flex items-center">
                    <Shield className="w-7 h-7 mr-2 text-indigo-600" /> Bid Compliance Check
                </h1>

                {/* Name Inputs */}
                <div className="bg-white p-5 rounded-xl shadow-lg border border-slate-100 space-y-3">
                    <h2 className="text-xl font-semibold text-slate-700">Document Information</h2>
                    <div>
                        <label htmlFor="rfqName" className="block text-sm font-medium text-slate-700">RFQ Name / ID</label>
                        <input
                            id="rfqName"
                            type="text"
                            value={rfqName}
                            onChange={(e) => setRfqName(e.target.value)}
                            className="mt-1 block w-full border border-slate-300 rounded-lg shadow-sm p-2 focus:ring-amber-500 focus:border-amber-500"
                            placeholder="e.g., Q3-2025 IT Services RFQ"
                        />
                    </div>
                    <div>
                        <label htmlFor="bidName" className="block text-sm font-medium text-slate-700">Bid Response Name / ID</label>
                        <input
                            id="bidName"
                            type="text"
                            value={bidName}
                            onChange={(e) => setBidName(e.target.value)}
                            className="mt-1 block w-full border border-slate-300 rounded-lg shadow-sm p-2 focus:ring-amber-500 focus:border-amber-500"
                            placeholder="e.g., TechSolutions Proposal v3.1"
                        />
                    </div>
                </div>

                {/* RFQ Textarea */}
                <div className="bg-white p-5 rounded-xl shadow-lg border border-slate-100">
                    <label htmlFor="rfqText" className="block text-xl font-semibold text-slate-700 mb-2 flex items-center">
                        <FileText className="w-5 h-5 mr-2 text-indigo-600" /> RFQ Content (Source Document)
                    </label>
                    <textarea
                        id="rfqText"
                        value={rfqText}
                        onChange={(e) => setRfqText(e.target.value)}
                        rows="12"
                        className="mt-1 block w-full border border-slate-300 rounded-lg shadow-sm p-3 focus:ring-amber-500 focus:border-amber-500 font-mono text-sm"
                        placeholder="Paste the full text of the Request For Quotation (RFQ) here..."
                    ></textarea>
                    <p className="text-xs text-slate-500 mt-1">Include key sections like Scope, Requirements, and Terms.</p>
                </div>

                {/* Bid Response Textarea */}
                <div className="bg-white p-5 rounded-xl shadow-lg border border-slate-100">
                    <label htmlFor="bidResponseText" className="block text-xl font-semibold text-slate-700 mb-2 flex items-center">
                        <Briefcase className="w-5 h-5 mr-2 text-indigo-600" /> Bid Response Content (Proposal)
                    </label>
                    <textarea
                        id="bidResponseText"
                        value={bidResponseText}
                        onChange={(e) => setBidResponseText(e.target.value)}
                        rows="12"
                        className="mt-1 block w-full border border-slate-300 rounded-lg shadow-sm p-3 focus:ring-amber-500 focus:border-amber-500 font-mono text-sm"
                        placeholder="Paste the full text of your corresponding Bid/Proposal response here..."
                    ></textarea>
                    <p className="text-xs text-slate-500 mt-1">This text will be checked for compliance against the RFQ requirements.</p>
                </div>

                {/* Submit Button */}
                <button
                    onClick={handleSubmit}
                    disabled={isLoading}
                    className="w-full flex items-center justify-center px-6 py-3 text-lg font-bold rounded-xl text-white bg-amber-600 hover:bg-amber-500 transition shadow-xl disabled:bg-slate-400 disabled:cursor-not-allowed"
                >
                    {isLoading ? (
                        <>
                            <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Analyzing...
                        </>
                    ) : (
                        <>
                            <Zap className="w-5 h-5 mr-2" /> Check Compliance
                        </>
                    )}
                </button>
                
                {/* Status Messages */}
                {error && (
                    <div className="p-3 bg-red-100 text-red-700 rounded-lg flex items-center">
                        <AlertTriangle className="w-5 h-5 mr-2" /> {error}
                    </div>
                )}
                {successMessage && (
                    <div className="p-3 bg-green-100 text-green-700 rounded-lg flex items-center">
                        <CheckCircle className="w-5 h-5 mr-2" /> {successMessage}
                    </div>
                )}
            </div>

            {/* Right Column: Report View */}
            <div className="w-full lg:w-2/3">
                <ComplianceReportView />
            </div>
        </div>
    );

    const HistoryPage = () => {
        const [filterUser, setFilterUser] = useState('');
        const [filterName, setFilterName] = useState('');
        const [sortOrder, setSortOrder] = useState('desc'); // 'asc' or 'desc'

        const filteredReports = useMemo(() => {
            let list = [...savedReports];

            // Filter by user ID
            if (filterUser) {
                list = list.filter(report => report.userId.toLowerCase().includes(filterUser.toLowerCase()));
            }

            // Filter by name (RFQ or Bid)
            if (filterName) {
                list = list.filter(report => 
                    report.rfqName.toLowerCase().includes(filterName.toLowerCase()) ||
                    report.bidName.toLowerCase().includes(filterName.toLowerCase())
                );
            }

            // Sort by date
            list.sort((a, b) => {
                const dateA = a.createdAt.getTime();
                const dateB = b.createdAt.getTime();
                return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
            });

            return list;
        }, [savedReports, filterUser, filterName, sortOrder]);


        return (
            <div className="p-4 space-y-6">
                <h1 className="text-3xl font-extrabold text-slate-800 flex items-center">
                    <Clock className="w-7 h-7 mr-2 text-indigo-600" /> Compliance History
                </h1>

                {/* Filters and Sorting */}
                <div className="bg-white p-5 rounded-xl shadow-lg border border-slate-100 grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="col-span-1 md:col-span-2">
                        <label htmlFor="filterName" className="block text-sm font-medium text-slate-700">Filter by RFQ/Bid Name</label>
                        <input
                            id="filterName"
                            type="text"
                            value={filterName}
                            onChange={(e) => setFilterName(e.target.value)}
                            className="mt-1 block w-full border border-slate-300 rounded-lg shadow-sm p-2 focus:ring-amber-500 focus:border-amber-500"
                            placeholder="Search name/ID"
                        />
                    </div>
                    <div>
                        <label htmlFor="filterUser" className="block text-sm font-medium text-slate-700">Filter by User ID</label>
                        <input
                            id="filterUser"
                            type="text"
                            value={filterUser}
                            onChange={(e) => setFilterUser(e.target.value)}
                            className="mt-1 block w-full border border-slate-300 rounded-lg shadow-sm p-2 focus:ring-amber-500 focus:border-amber-500"
                            placeholder="Search user ID"
                        />
                    </div>
                    <div>
                        <label htmlFor="sortOrder" className="block text-sm font-medium text-slate-700">Sort Date</label>
                        <select
                            id="sortOrder"
                            value={sortOrder}
                            onChange={(e) => setSortOrder(e.target.value)}
                            className="mt-1 block w-full border border-slate-300 rounded-lg shadow-sm p-2 focus:ring-amber-500 focus:border-amber-500 bg-white"
                        >
                            <option value="desc">Newest First</option>
                            <option value="asc">Oldest First</option>
                        </select>
                    </div>
                </div>

                {/* Report List */}
                <h2 className="text-xl font-bold text-slate-700 border-b pb-2">
                    Total Reports: {filteredReports.length}
                </h2>
                
                {filteredReports.length === 0 ? (
                    <div className="p-8 text-center text-slate-500 bg-white rounded-xl shadow-lg">
                        <HardDrive className="w-8 h-8 mx-auto mb-3" />
                        No reports found matching your criteria.
                    </div>
                ) : (
                    <div className="space-y-4">
                        {filteredReports.map((item) => {
                            const reportSummary = item.reportData?.report_summary || {};
                            return (
                                <div key={item.id} className="bg-white p-5 rounded-xl shadow-lg border border-slate-100 hover:shadow-xl transition">
                                    <div className="flex justify-between items-start mb-3">
                                        <div>
                                            <p className="text-lg font-bold text-indigo-600">{item.rfqName}</p>
                                            <p className="text-sm font-medium text-slate-700">vs. {item.bidName}</p>
                                        </div>
                                        <div className="flex flex-col items-end space-y-1">
                                            <StatusBadge status={reportSummary.overall_status || 'N/A'} />
                                            <p className="text-xs text-slate-500">Score: <span className="font-bold text-indigo-500">{reportSummary.compliance_percentage || 0}%</span></p>
                                        </div>
                                    </div>

                                    <div className="text-sm text-slate-600 mb-4 border-t pt-3">
                                        <p className="text-xs text-slate-500">Saved by: <span className="font-mono text-xs bg-slate-100 p-1 rounded">{item.userId}</span> ({item.userName})</p>
                                        <p className="text-xs text-slate-500">Date: {item.createdAt.toLocaleDateString()} {item.createdAt.toLocaleTimeString()}</p>
                                        <p className="mt-2 italic text-slate-700">Recommendation: {reportSummary.summary_recommendation || 'No summary recommendation.'}</p>
                                    </div>

                                    <div className="flex justify-end space-x-3 mt-4">
                                        <button
                                            onClick={() => loadReport(item)}
                                            className="flex items-center px-4 py-2 text-xs font-semibold rounded-lg text-slate-900 bg-amber-500 hover:bg-amber-400 transition"
                                            title="Load report details into the Compliance Check page"
                                        >
                                            <ArrowLeft className="w-3 h-3 mr-1 rotate-180"/> Load
                                        </button>
                                        {/* Delete Button - ONLY RENDERED FOR ADMIN */}
                                        {currentUser && currentUser.role === 'ADMIN' && (
                                            <button
                                                onClick={() => deleteReport(item.id, item.rfqName, item.bidName)}
                                                className="flex items-center px-4 py-2 text-xs font-semibold rounded-lg text-white bg-red-600 hover:bg-red-500 transition shadow-md"
                                                title="Click to Delete Report Permanently"
                                            >
                                                <Trash2 className="w-3 h-3 mr-1"/> Delete
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    const AdminDashboard = () => {
        if (currentUser?.role !== 'ADMIN') {
            return (
                <div className="p-8 text-center bg-red-50 border border-red-200 rounded-xl">
                    <AlertTriangle className="w-8 h-8 mx-auto text-red-600 mb-3" />
                    <h1 className="text-xl font-bold text-red-700">Access Denied</h1>
                    <p className="text-red-500">You do not have administrative privileges to view this page.</p>
                </div>
            );
        }

        return (
            <div className="p-4 space-y-6">
                <h1 className="text-3xl font-extrabold text-slate-800 flex items-center">
                    <Settings className="w-7 h-7 mr-2 text-red-600" /> Admin Dashboard
                </h1>

                {/* User Management Section */}
                <div className="bg-white p-6 rounded-xl shadow-lg border border-slate-100">
                    <h2 className="text-2xl font-bold text-slate-700 mb-4 flex items-center">
                        <Users className="w-5 h-5 mr-2 text-red-600" /> User Management
                    </h2>
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-slate-200">
                            <thead className="bg-slate-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">User ID</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Email</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Current Role</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-slate-200">
                                {adminUserList.map((user) => (
                                    <tr key={user.uid}>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-slate-600">{user.uid}</td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-800">{user.email}</td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${user.role === 'ADMIN' ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`}>
                                                {user.role}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                                            {user.role !== 'ADMIN' && (
                                                <button
                                                    onClick={() => updateUserRole(user.uid, 'ADMIN')}
                                                    className="text-indigo-600 hover:text-indigo-900 mr-3"
                                                >
                                                    Promote to Admin
                                                </button>
                                            )}
                                            {user.role === 'ADMIN' && (
                                                <button
                                                    onClick={() => updateUserRole(user.uid, 'USER')}
                                                    className="text-amber-600 hover:text-amber-900"
                                                >
                                                    Demote to User
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Reports Overview */}
                <div className="bg-white p-6 rounded-xl shadow-lg border border-slate-100">
                    <h2 className="text-2xl font-bold text-slate-700 mb-4 flex items-center">
                        <HardDrive className="w-5 h-5 mr-2 text-red-600" /> Global Reports Overview
                    </h2>
                    <p className="mb-4 text-slate-600">Total Reports in System: <span className="font-bold">{adminAllReports.length}</span></p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {adminAllReports.map((report) => (
                             <div key={report.id} className="p-4 border rounded-lg bg-slate-50">
                                 <p className="font-bold text-slate-800 truncate">{report.rfqName}</p>
                                 <p className="text-xs text-slate-500">User: {report.userName}</p>
                                 <p className="text-xs text-slate-500">Date: {report.createdAt.toLocaleDateString()}</p>
                                 <div className="mt-2 flex justify-end">
                                     <button 
                                        onClick={() => deleteReport(report.id, report.rfqName, report.bidName)}
                                        className="text-red-600 hover:text-red-800 text-xs flex items-center"
                                     >
                                         <Trash2 className="w-3 h-3 mr-1"/> Delete
                                     </button>
                                 </div>
                             </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    const AuthView = () => (
        <div className="flex flex-col items-center justify-center min-h-[60vh]">
            <div className="bg-white p-8 rounded-2xl shadow-2xl border border-slate-100 max-w-md w-full text-center">
                <Shield className="w-16 h-16 text-indigo-600 mx-auto mb-4" />
                <h1 className="text-3xl font-extrabold text-slate-800 mb-2">SmartBid Compliance</h1>
                <p className="text-slate-500 mb-8">Secure AI-Powered Bid Analysis</p>
                
                <div className="space-y-4">
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                        <p className="text-sm text-slate-600 mb-2">Sign in anonymously to start checking bids immediately.</p>
                        {/* Anonymous login is handled automatically by the useEffect hook */}
                        <p className="text-xs text-indigo-600 font-semibold flex items-center justify-center">
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Authenticating...
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );

    // --- Main Render ---
    return (
        <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
            {/* Navigation Bar */}
            <nav className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between h-16">
                        <div className="flex items-center cursor-pointer" onClick={() => setCurrentPage(PAGE.HOME)}>
                            <Shield className="w-8 h-8 text-indigo-600 mr-2" />
                            <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-amber-600">
                                SmartBid Compliance
                            </span>
                        </div>
                        <div className="flex items-center space-x-4">
                            {isAuthReady && currentUser ? (
                                <>
                                    <button 
                                        onClick={() => setCurrentPage(PAGE.COMPLIANCE_CHECK)}
                                        className={`px-3 py-2 rounded-md text-sm font-medium transition ${currentPage === PAGE.COMPLIANCE_CHECK ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'}`}
                                    >
                                        Check Compliance
                                    </button>
                                    <button 
                                        onClick={() => setCurrentPage(PAGE.HISTORY)}
                                        className={`px-3 py-2 rounded-md text-sm font-medium transition ${currentPage === PAGE.HISTORY ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'}`}
                                    >
                                        History
                                    </button>
                                    {currentUser.role === 'ADMIN' && (
                                        <button 
                                            onClick={() => setCurrentPage(PAGE.ADMIN_DASHBOARD)}
                                            className={`px-3 py-2 rounded-md text-sm font-medium transition ${currentPage === PAGE.ADMIN_DASHBOARD ? 'bg-red-50 text-red-700' : 'text-slate-600 hover:text-red-700 hover:bg-red-50'}`}
                                        >
                                            Admin
                                        </button>
                                    )}
                                    <div className="ml-2 flex items-center space-x-2 pl-2 border-l border-slate-200">
                                        <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-700 font-bold text-xs">
                                            {currentUser.role === 'ADMIN' ? 'AD' : 'US'}
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <span className="text-sm text-slate-400">Initializing...</span>
                            )}
                        </div>
                    </div>
                </div>
            </nav>

            {/* Main Content Area */}
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {!isAuthReady ? (
                    <div className="flex flex-col items-center justify-center h-64">
                        <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mb-4" />
                        <p className="text-slate-500 font-medium">Connecting to Secure Services...</p>
                    </div>
                ) : !currentUser ? (
                    <AuthView />
                ) : (
                    <>
                        {currentPage === PAGE.HOME && (
                            <div className="text-center py-16">
                                <h1 className="text-4xl font-extrabold text-slate-900 mb-6">
                                    AI-Powered Bid Compliance
                                </h1>
                                <p className="text-xl text-slate-600 max-w-2xl mx-auto mb-10">
                                    Instantly analyze bid proposals against RFQ requirements using advanced Generative AI. 
                                    Detect risks, verify compliance, and streamline your procurement process.
                                </p>
                                <div className="flex justify-center space-x-4">
                                    <button 
                                        onClick={() => setCurrentPage(PAGE.COMPLIANCE_CHECK)}
                                        className="px-8 py-4 bg-indigo-600 text-white text-lg font-bold rounded-xl shadow-lg hover:bg-indigo-500 transition flex items-center"
                                    >
                                        <Zap className="w-5 h-5 mr-2" /> Start New Analysis
                                    </button>
                                    <button 
                                        onClick={() => setCurrentPage(PAGE.HISTORY)}
                                        className="px-8 py-4 bg-white text-slate-700 text-lg font-bold rounded-xl shadow-lg border border-slate-200 hover:bg-slate-50 transition flex items-center"
                                    >
                                        <Clock className="w-5 h-5 mr-2" /> View History
                                    </button>
                                </div>
                            </div>
                        )}
                        {currentPage === PAGE.COMPLIANCE_CHECK && <ComplianceCheckPage />}
                        {currentPage === PAGE.HISTORY && <HistoryPage />}
                        {currentPage === PAGE.ADMIN_DASHBOARD && <AdminDashboard />}
                    </>
                )}
            </main>
        </div>
    );
}

// --- Top-level export component using the ErrorBoundary ---
function TopLevelApp() {
    return (
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    );
}

export default TopLevelApp;
