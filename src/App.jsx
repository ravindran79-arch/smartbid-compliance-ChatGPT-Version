import React, { useState, useCallback, useEffect } from 'react';
import { 
    FileUp, Send, Loader2, AlertTriangle, CheckCircle, List, FileText, BarChart2,
    Save, Clock, Zap, ArrowLeft, Users, Briefcase, Layers, UserPlus, LogIn, Tag,
    Shield, User, HardDrive, Phone, Mail, Building, Trash2 
} from 'lucide-react'; 

// --- FIREBASE IMPORTS ---
import { initializeApp } from 'firebase/app';
import { 
    getAuth, 
    signInAnonymously, // Keeping this for initial setup, but we now prefer email/password
    signInWithCustomToken, 
    onAuthStateChanged,
    createUserWithEmailAndPassword, // NEW
    signInWithEmailAndPassword,     // NEW
    signOut,                        // NEW
} from 'firebase/auth';
import { 
    getFirestore, collection, addDoc, onSnapshot, query, doc, setDoc, updateDoc, 
    runTransaction, deleteDoc, getDoc, getDocs, collectionGroup, where, orderBy // NEW: getDoc, getDocs, collectionGroup
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
    ADMIN: 'ADMIN',                     
    HISTORY: 'HISTORY' 
};

// --- JSON Schema for the Comprehensive Report (UPDATED with negotiationStance) ---
const COMPREHENSIVE_REPORT_SCHEMA = {
    type: "OBJECT",
    description: "The complete compliance audit report, including a high-level summary and detailed requirement findings.",
    properties: {
        "executiveSummary": {
            "type": "STRING",
            "description": "A concise, high-level summary of the compliance audit, stating the overall compliance score, and the key areas of failure or success."
        },
        "findings": {
            type: "ARRAY",
            description: "A list of detailed compliance findings.",
            items: {
                type: "OBJECT",
                properties: {
                    "requirementFromRFQ": {
                        "type": "STRING",
                        "description": "The specific mandatory requirement or clause extracted verbatim from the RFQ document."
                    },
                    "complianceScore": {
                        "type": "NUMBER",
                        "description": "The score indicating compliance: 1 for Full Compliance, 0.5 for Partially Addressed, 0 for Non-Compliant/Missing."
                    },
                    "bidResponseSummary": {
                        "type: "STRING",
                        "description": "A concise summary of how the Bid addressed (or failed to address) the requirement, including a direct quote or section reference if possible."
                    },
                    "flag": {
                        "type": "STRING",
                        "enum": ["COMPLIANT", "PARTIAL", "NON-COMPLIANT"],
                        "description": "A categorical flag based on the score (1=COMPLIANT, 0.5=PARTIAL, 0=NON-COMPLIANT)."
                    },
                    "category": {
                        "type": "STRING",
                        "enum": CATEGORY_ENUM,
                        "description": "The functional category this requirement belongs to, inferred from its content (e.g., LEGAL, FINANCIAL, TECHNICAL, TIMELINE, REPORTING, ADMINISTRATIVE, OTHER)."
                    },
                    "negotiationStance": {
                        "type": "STRING",
                        "description": "For items flagged as PARTIAL or NON-COMPLIANT (score < 1), suggest a revised, compromise statement (1-2 sentences) that the Bidder can use to open a negotiation channel. This stance must acknowledge the RFQ requirement while offering a viable alternative or minor concession. Omit this field for COMPLIANT findings (score = 1)."
                    }
                },
                "propertyOrdering": ["requirementFromRFQ", "complianceScore", "bidResponseSummary", "flag", "category", "negotiationStance"]
            }
        }
    },
    "required": ["executiveSummary", "findings"],
    "propertyOrdering": ["executiveSummary", "findings"]
};

// --- Utility Function for API Call with Retry Logic ---
const fetchWithRetry = async (url, options, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            return response;
        } catch (error) {
            if (i === maxRetries - 1) throw error; // Re-throw if last attempt
            const delay = Math.pow(2, i) * 1000; // Exponential backoff (1s, 2s, 4s)
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

// --- Utility Function to get Firestore Document Reference for Usage ---
const getUsageDocRef = (db, userId) => {
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
    // Path: /artifacts/{appId}/users/{userId}/usage_limits/main_tracker
    return doc(db, `artifacts/${appId}/users/${userId}/usage_limits`, 'main_tracker');
};

// --- Utility function to calculate the standard compliance percentage (Unweighted) ---
const getCompliancePercentage = (report) => {
    const findings = report.findings || []; 
    const totalScore = findings.reduce((sum, item) => sum + (item.complianceScore || 0), 0);
    const totalRequirements = findings.length;
    const maxScore = totalRequirements * 1;
    return maxScore > 0 ? parseFloat(((totalScore / maxScore) * 100).toFixed(1)) : 0;
};


// --- Universal File Processor (handles TXT, PDF, DOCX) ---
const processFile = (file) => {
    // NOTE: This uses global libraries loaded via script tags in the App component's useEffect
    return new Promise(async (resolve, reject) => {
        const fileExtension = file.name.split('.').pop().toLowerCase();
        const reader = new FileReader();

        if (fileExtension === 'txt') {
            reader.onload = (event) => resolve(event.target.result);
            reader.onerror = reject;
            reader.readAsText(file);
        } else if (fileExtension === 'pdf') {
            if (typeof window.pdfjsLib === 'undefined' || !window.pdfjsLib.getDocument) {
                return reject("PDF parsing library (pdf.js) not fully loaded or initialized. PDF support disabled.");
            }
            reader.onload = async (event) => {
                try {
                    const pdfData = new Uint8Array(event.target.result);
                    const pdf = await window.pdfjsLib.getDocument({ data: pdfData }).promise;
                    let fullText = '';
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const textContent = await page.getTextContent();
                        fullText += textContent.items.map(item => item.str).join(' ') + '\n\n'; 
                    }
                    resolve(fullText);
                } catch (e) {
                    reject('Error parsing PDF. Detail: ' + e.message);
                }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        } else if (fileExtension === 'docx') {
            if (typeof window.mammoth === 'undefined') {
                 return reject("DOCX parsing library (mammoth.js) not loaded. DOCX support disabled.");
            }
            reader.onload = async (event) => {
                try {
                    const result = await window.mammoth.extractRawText({ arrayBuffer: event.target.result });
                    resolve(result.value); 
                } catch (e) {
                    reject('Error parsing DOCX. Detail: ' + e.message);
                }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        } else {
            reject('Unsupported file type. Please use .txt, .pdf, or .docx.');
        }
    });
};

// --- CORE: Error Boundary Component to prevent white screens ---
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        console.error("Uncaught error:", error, errorInfo);
        this.setState({
            error: error,
            errorInfo: errorInfo
        });
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen bg-red-900 font-body p-4 sm:p-8 text-white flex items-center justify-center">
                    <div className="bg-red-800 p-8 rounded-xl border border-red-500 max-w-lg">
                        <AlertTriangle className="w-8 h-8 text-red-300 mx-auto mb-4"/>
                        <h2 className="text-xl font-bold mb-2">Critical Application Error</h2>
                        <p className="text-sm text-red-200">The application crashed during render.</p>
                        <p className="text-sm mt-3 font-mono break-all bg-red-900 p-2 rounded">
                            **Error Message:** {this.state.error && this.state.error.toString()}
                        </p>
                    </div>
                </div>
            );
        }

        return this.props.children; 
    }
}

// --- Helper Function for File Input Handling ---
const handleFileChange = (e, setFile, setErrorMessage) => {
    if (e.target.files.length > 0) {
        setFile(e.target.files[0]);
        if (setErrorMessage) setErrorMessage(null); 
    }
};

// --- AuthPage Component (Now uses REAL Firebase Auth) ---
const FormInput = ({ label, name, value, onChange, type, placeholder }) => (
    <div>
        <label htmlFor={name} className="block text-sm font-medium text-slate-300 mb-1">
            {label}
        </label>
        <input
            id={name}
            name={name}
            type={type}
            value={value}
            onChange={onChange}
            placeholder={placeholder || ''}
            required={label.includes('*')}
            className="w-full px-3 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:ring-amber-500 focus:border-amber-500 text-sm"
        />
    </div>
);

// UPDATED AuthPage signature for REAL Firebase Auth
const AuthPage = ({ 
    setCurrentPage, setErrorMessage, isAuthReady, errorMessage, 
    auth, db, setUserProfile, userId
}) => {
    const [regForm, setRegForm] = useState({
        name: '', designation: '', company: '', email: '', phone: '',
        password: ''
    });

    const [loginForm, setLoginForm] = useState({
        email: '', password: ''
    });

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isRegistering, setIsRegistering] = useState(false);
    
    const handleRegChange = (e) => {
        setRegForm({ ...regForm, [e.target.name]: e.target.value });
    };

    const handleLoginChange = (e) => {
        setLoginForm({ ...loginForm, [e.target.name]: e.target.value });
    };

    // --- NEW: Firebase Registration Logic ---
    const handleRegister = async (e) => {
        e.preventDefault();
        setErrorMessage(null);
        setIsRegistering(true);

        const required = ['name', 'designation', 'company', 'email', 'password'];
        const missing = required.filter(field => !regForm[field]);

        if (missing.length > 0) {
            setErrorMessage(`Please fill all required fields: ${missing.join(', ')}.`);
            setIsRegistering(false);
            return;
        }

        try {
            // 1. Create user in Firebase Auth
            const userCredential = await createUserWithEmailAndPassword(
                auth, regForm.email, regForm.password
            );
            const user = userCredential.user;

            // 2. Create user profile in Firestore
            const userDocRef = doc(db, 'users', user.uid);
            // NOTE: The first registered user can be an admin for setup, otherwise, all new users are 'USER'.
            // For this demo, we set all new registrations to 'USER'. Admin accounts must be created manually 
            // in the Firebase Console and then have their role set in Firestore.
            const profileData = {
                name: regForm.name,
                role: 'USER', 
                designation: regForm.designation, 
                company: regForm.company,         
                email: regForm.email,             
                phone: regForm.phone || null,             
                createdAt: Date.now(),
            };
            await setDoc(userDocRef, profileData);

            setErrorMessage(`Success! User '${regForm.email}' registered and logged in.`);
            // The onAuthStateChanged listener in App will handle navigation.

        } catch (error) {
            console.error("Registration failed:", error);
            // Handle common Firebase errors
            if (error.code === 'auth/email-already-in-use') {
                setErrorMessage('Registration failed: This email is already in use.');
            } else if (error.code === 'auth/weak-password') {
                setErrorMessage('Registration failed: Password should be at least 6 characters.');
            } else {
                setErrorMessage(`Registration failed: ${error.message}`);
            }
        } finally {
            setIsRegistering(false);
        }
    };

    // --- NEW: Firebase Login Logic ---
    const handleLogin = async (e) => {
        e.preventDefault();
        setErrorMessage(null);
        setIsSubmitting(true);

        if (!loginForm.email || !loginForm.password) {
            setErrorMessage("Please enter both email and password.");
            setIsSubmitting(false);
            return;
        }
        
        try {
            // 1. Sign in with Firebase Auth
            await signInWithEmailAndPassword(auth, loginForm.email, loginForm.password);
            
            setErrorMessage(`Login successful. Fetching profile...`);
            // The onAuthStateChanged listener in App will handle fetching the profile and navigation.

        } catch (error) {
            console.error("Login failed:", error);
             // Handle common Firebase errors
            if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
                setErrorMessage("Login failed: Invalid email or password.");
            } else {
                setErrorMessage(`Login failed: ${error.message}`);
            }
        } finally {
            setIsSubmitting(false);
        }
    };
    
    // Status text update
    const authStatusText = isAuthReady 
        ? (userId ? "A user session is active. Redirecting..." : "Ready for login.")
        : "Initializing authentication...";

    return (
        <div className="p-8 bg-slate-800 rounded-2xl shadow-2xl shadow-black/50 border border-slate-700 mt-12 mb-12">
            <h2 className="text-3xl font-extrabold text-white text-center">Welcome to SmartBids</h2>
            
            <p className="text-lg font-medium text-blue-400 text-center mb-6">
                AI-Driven Bid Compliance Audit: Smarter Bids, Every Time!
            </p>
            
          
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* --- Section 1: New User Registration --- */}
                <div className="p-6 bg-slate-700/50 rounded-xl border border-blue-500/50 shadow-inner space-y-4">
                    <h3 className="text-2xl font-bold text-blue-300 flex items-center mb-4">
                        <UserPlus className="w-6 h-6 mr-2" /> New User Registration
                    </h3>
                    <form onSubmit={handleRegister} className="space-y-3">
                        <FormInput label="Full Name *" name="name" value={regForm.name} onChange={handleRegChange} type="text" />
                        <FormInput label="Designation *" name="designation" value={regForm.designation} onChange={handleRegChange} type="text" />
                        <FormInput label="Company *" name="company" value={regForm.company} onChange={handleRegChange} type="text" />
                        
                        <FormInput label="Email *" name="email" value={regForm.email} onChange={handleRegChange} type="email" />
                        <FormInput label="Contact Number" name="phone" value={regForm.phone} onChange={handleRegChange} type="tel" placeholder="Optional" />
                        
                        <FormInput label="Create Password *" name="password" value={regForm.password} onChange={handleRegChange} type="password" />

                        <button
                            type="submit"
                            disabled={isRegistering}
                            className={`w-full py-3 text-lg font-semibold rounded-xl text-slate-900 transition-all shadow-lg mt-6
                                bg-blue-400 hover:bg-blue-300 disabled:opacity-50 flex items-center justify-center
                            `}
                        >
                            {isRegistering ? <Loader2 className="animate-spin h-5 w-5 mr-2" /> : <UserPlus className="h-5 w-5 mr-2" />}
                            {isRegistering ? 'Registering...' : 'Register User'}
                        </button>
                    </form>
                </div>

                {/* --- Section 2: Returning User Login --- */}
                <div className="p-6 bg-slate-700/50 rounded-xl border border-green-500/50 shadow-inner flex flex-col justify-center">
                    <h3 className="text-2xl font-bold text-green-300 flex items-center mb-4">
                        <LogIn className="w-6 h-6 mr-2" /> Returning User Login
                    </h3>
                    <form onSubmit={handleLogin} className="space-y-4">
                        <FormInput label="Email *" name="email" value={loginForm.email} onChange={handleLoginChange} type="email" />
                        <FormInput label="Password *" name="password" value={loginForm.password} onChange={handleLoginChange} type="password" />
                        
                        <button
                            type="submit"
                            disabled={isSubmitting}
                            className={`w-full py-3 text-lg font-semibold rounded-xl text-slate-900 transition-all shadow-lg mt-6
                                bg-green-400 hover:bg-green-300 disabled:opacity-50 flex items-center justify-center
                            `}
                        >
                            {isSubmitting ? <Loader2 className="animate-spin h-5 w-5 mr-2" /> : <LogIn className="h-5 w-5 mr-2" />}
                            {isSubmitting ? 'Logging In...' : 'Login & Access Dashboard'}
                        </button>
                    </form>
                    
                    {/* Error Message Display */}
                    {errorMessage && (
                        <div className="mt-4 p-3 bg-red-900/40 text-red-300 border border-red-700 rounded-xl flex items-center">
                            <AlertTriangle className="w-5 h-5 mr-3"/>
                            <p className="text-sm font-medium">{errorMessage}</p>
                        </div>
                    )}
                </div>
            </div>
            <p className="text-center text-sm text-slate-500 mt-6 pt-4 border-t border-slate-700">
                Authentication Status: <span className="font-medium text-slate-400">{authStatusText}</span>
            </p>
        </div>
    );
};


// --- Core Components (FileUploader, Report, DetailItem, etc. remain the same) ---

// --- FileUploader sub-component ---
const FileUploader = ({ title, file, setFile, color, requiredText }) => (
    <div className={`p-5 rounded-xl border border-${color}-500/50 bg-slate-700/50 shadow-inner space-y-3`}>
        <h3 className="text-xl font-bold text-white flex items-center">
            <FileText className={`w-5 h-5 mr-2 text-${color}-400`}/> {title}
        </h3>
        <p className="text-sm text-slate-400">{requiredText}</p>
        <label className={`w-full flex items-center justify-center px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer transition-colors 
            ${file ? `border-${color}-400 bg-${color}-900/20` : 'border-slate-500 hover:border-amber-500'}
        `}>
            {file ? (
                <span className={`text-${color}-300 font-semibold flex items-center`}>
                    <CheckCircle className="w-5 h-5 mr-2" /> {file.name}
                </span>
            ) : (
                <span className="text-slate-400 flex items-center">
                    <FileUp className="w-5 h-5 mr-2" /> Click to upload
                </span>
            )}
            <input 
                type="file" 
                onChange={setFile} 
                className="hidden" 
                accept=".txt,.pdf,.docx"
            />
        </label>
        {file && (
            <button onClick={() => setFile(null)} className="text-xs text-red-400 hover:text-red-300 flex items-center mt-2">
                <Trash2 className="w-3 h-3 mr-1"/> Remove File
            </button>
        )}
    </div>
);

// --- ReportViewer Component ---
const ReportViewer = ({ report, RFQFile, BidFile, getCompliancePercentage }) => {
    if (!report) return null;

    const findings = report.findings || [];
    const totalRequirements = findings.length;
    const overallScore = getCompliancePercentage(report);

    const counts = findings.reduce((acc, item) => {
        // Fallback for unexpected data
        const flag = item.flag && ['COMPLIANT', 'PARTIAL', 'NON-COMPLIANT'].includes(item.flag) ? item.flag : 'NON-COMPLIANT';
        acc[flag] = (acc[flag] || 0) + 1;
        return acc;
    }, { 'COMPLIANT': 0, 'PARTIAL': 0, 'NON-COMPLIANT': 0 });

    const getWidth = (flag) => {
        if (totalRequirements === 0) return '0%';
        return `${(counts[flag] / totalRequirements) * 100}%`;
    };

    const getFlagColor = (flag) => {
        switch (flag) {
            case 'COMPLIANT': return 'bg-green-700/30 text-green-300 border-green-500/50';
            case 'PARTIAL': return 'bg-amber-700/30 text-amber-300 border-amber-500/50';
            case 'NON-COMPLIANT': return 'bg-red-700/30 text-red-300 border-red-500/50';
            default: return 'bg-gray-700/30 text-gray-300 border-gray-500/50';
        }
    };

    const getCategoryColor = (category) => {
        switch (category) {
            case 'TECHNICAL': return 'bg-purple-700 text-purple-200';
            case 'FINANCIAL': return 'bg-green-700 text-green-200';
            case 'LEGAL': return 'bg-red-700 text-red-200';
            case 'TIMELINE': return 'bg-blue-700 text-blue-200';
            case 'REPORTING': return 'bg-yellow-700 text-yellow-200';
            case 'ADMINISTRATIVE': return 'bg-indigo-700 text-indigo-200';
            default: return 'bg-slate-700 text-slate-400';
        }
    };

    return (
        <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl shadow-black/50 border border-slate-700 mt-8">
            <h2 className="text-3xl font-extrabold text-white flex items-center mb-6 border-b border-slate-700 pb-3">
                <BarChart2 className="w-8 h-8 mr-3 text-amber-500"/> Compliance Audit Report
            </h2>

            {/* Header & Score */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <StatCard 
                    icon={<FileText className="w-6 h-6 text-slate-400"/>}
                    label="RFQ Document"
                    value={RFQFile?.name || 'N/A'}
                    isText={true}
                />
                <StatCard 
                    icon={<FileText className="w-6 h-6 text-slate-400"/>}
                    label="Bid Document"
                    value={BidFile?.name || 'N/A'}
                    isText={true}
                />
                <StatCard 
                    icon={<Zap className="w-8 h-8 text-green-400"/>}
                    label="Overall Compliance Score"
                    value={`${overallScore}%`}
                />
            </div>
            
            {/* Executive Summary */}
            <div className="p-5 bg-slate-900/50 rounded-xl border border-slate-700 mb-8">
                <h3 className="text-xl font-bold text-amber-400 mb-3">Executive Summary</h3>
                <p className="text-slate-300 leading-relaxed italic">
                    {report.executiveSummary}
                </p>
            </div>
            
            {/* Compliance Progress Bar */}
            <div className="mb-8">
                <h3 className="text-lg font-bold text-white mb-3">Compliance Breakdown ({totalRequirements} Total Requirements)</h3>
                <div className="flex w-full h-8 rounded-lg overflow-hidden border border-slate-700">
                    <div className="flex items-center justify-center text-sm font-semibold transition-all duration-500 bg-green-600" style={{ width: getWidth('COMPLIANT') }}>
                        {counts['COMPLIANT'] > 0 && `${counts['COMPLIANT']} Compliant`}
                    </div>
                    <div className="flex items-center justify-center text-sm font-semibold transition-all duration-500 bg-amber-500" style={{ width: getWidth('PARTIAL') }}>
                        {counts['PARTIAL'] > 0 && `${counts['PARTIAL']} Partial`}
                    </div>
                    <div className="flex items-center justify-center text-sm font-semibold transition-all duration-500 bg-red-600" style={{ width: getWidth('NON-COMPLIANT') }}>
                        {counts['NON-COMPLIANT'] > 0 && `${counts['NON-COMPLIANT']} Non-Compliant`}
                    </div>
                </div>
            </div>

            {/* Detailed Findings */}
            <h3 className="text-2xl font-bold text-white mb-4 border-b border-slate-700 pb-2 flex items-center">
                <List className="w-5 h-5 mr-2 text-slate-400"/> Detailed Findings
            </h3>
            <div className="space-y-6">
                {findings.map((item, index) => (
                    <div key={index} className="p-5 rounded-xl border border-slate-700 bg-slate-900/50 space-y-2">
                        <div className="flex flex-wrap justify-between items-start">
                            <h3 className="text-xl font-bold text-white mb-2 sm:mb-0"> Requirement #{index + 1} </h3>
                            {/* Tags Group */}
                            <div className="flex flex-col sm:flex-row items-end sm:items-center space-y-2 sm:space-y-0 sm:space-x-3">
                                {/* Category Tag */}
                                {item.category && (
                                    <div className={`px-2 py-0.5 text-xs font-bold rounded-full ${getCategoryColor(item.category)} flex items-center`}>
                                        <Tag className="w-3 h-3 mr-1"/> {item.category}
                                    </div>
                                )}
                                {/* Compliance Flag */}
                                <div className={`px-4 py-1 text-sm font-semibold rounded-full border ${getFlagColor(item.flag)}`}>
                                    {item.flag} ({item.complianceScore})
                                </div>
                            </div>
                        </div>
                        <p className="font-semibold text-slate-300 mt-2">RFQ Requirement Extracted:</p>
                        <p className="p-4 bg-slate-900/80 text-slate-200 rounded-lg border border-slate-700 italic text-sm leading-relaxed">
                            {item.requirementFromRFQ}
                        </p>
                        <p className="font-semibold text-slate-300 mt-4">Bidder's Response Summary:</p>
                        <p className="text-slate-400 leading-relaxed text-sm">
                            {item.bidResponseSummary}
                        </p>
                        {/* --- NEW: Negotiation Friendly Stance --- */}
                        {item.negotiationStance && (
                            <div className="mt-4 p-4 bg-blue-900/40 border border-blue-700 rounded-xl space-y-2">
                                <p className="font-semibold text-blue-300 flex items-center">
                                    <Briefcase className="w-4 h-4 mr-2"/> Recommended Negotiation Stance:
                                </p>
                                <p className="text-blue-200 leading-relaxed text-sm">
                                    {item.negotiationStance}
                                </p>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

// Simple component for metrics below the chart
const StatCard = ({ icon, label, value, isText = false }) => (
    <div className="bg-slate-700/50 p-4 rounded-xl border border-slate-600 flex items-center space-x-4">
        <div className="flex-shrink-0">{icon}</div>
        <div>
            <div className={`font-extrabold text-white ${isText ? 'text-sm' : 'text-3xl'}`}>{value}</div>
            <div className="text-xs text-slate-400">{label}</div>
        </div>
    </div>
);

// --- DetailItem sub-component for AdminDashboard ---
const DetailItem = ({ icon: Icon, label, value }) => (
    <div className="flex items-center space-x-2">
        <Icon className="w-4 h-4 text-slate-400"/>
        <p className="text-sm font-medium text-slate-400">{label}: <span className="text-white">{value}</span></p>
    </div>
);

// --- UserProfileCard sub-component for AdminDashboard ---
const UserProfileCard = ({ user }) => (
    <div className="p-4 bg-slate-900/50 rounded-xl border border-slate-800 shadow-md">
        <div className="flex items-center justify-between">
            <h4 className="text-lg font-bold text-white">{user.name}</h4>
            <span className={`px-3 py-1 text-xs rounded-full font-semibold ${user.role === 'ADMIN' ? 'bg-red-500 text-white' : 'bg-green-500 text-slate-900'}`}>
                {user.role} 
            </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 mt-4">
            <DetailItem icon={Briefcase} label="Designation" value={user.designation} />
            <DetailItem icon={Building} label="Company" value={user.company} />
            <DetailItem icon={Mail} label="Email" value={user.email} />
            <DetailItem icon={Phone} label="Contact" value={user.phone || 'N/A'} />
        </div>
        <p className="text-xs text-slate-500 mt-3 border-t border-slate-800 pt-2">
            User ID: <span className='text-slate-400 font-mono text-[10px] break-all'>{user.uid}</span>
        </p>
    </div>
);

// --- NEW: ComplianceRanking for History Page ---
const ComplianceRanking = ({ reportsHistory, loadReportFromHistory, deleteReport, currentUser }) => {
    // 1. Group reports by the RFQ they were checked against
    const projects = reportsHistory.reduce((acc, report) => {
        const rfqName = report.rfqName || 'Untitled RFQ';
        if (!acc[rfqName]) {
            acc[rfqName] = {
                count: 0,
                allReports: [],
            };
        }
        acc[rfqName].count += 1;
        // Calculate percentage for sorting
        const percentage = getCompliancePercentage(report);
        acc[rfqName].allReports.push({ ...report, percentage });
        return acc;
    }, {});

    const rankedProjects = Object.entries(projects);

    // 2. Function to sort and rank reports within a single RFQ group
    const getRankedReports = (reports) => {
        // Sort by percentage descending
        const sortedReports = [...reports].sort((a, b) => b.percentage - a.percentage);

        let currentRank = 1;
        let lastPercentage = -1;
        return sortedReports.map((report, index) => {
            // Only increase rank if the percentage drops
            if (report.percentage < lastPercentage) {
                currentRank = index + 1;
            }
            lastPercentage = report.percentage;
            return { ...report, rank: currentRank };
        });
    };

    return (
        <div className="mt-8">
            <h2 className="text-xl font-bold text-white flex items-center mb-4 border-b border-slate-700 pb-2">
                <Layers className="w-5 h-5 mr-2 text-blue-400"/> Compliance Ranking by RFQ 
            </h2>
            <p className="text-sm text-slate-400 mb-6"> 
                All saved bids are ranked by compliance score for each specific RFQ. 
            </p>
            <div className="space-y-6">
                {rankedProjects.map(([rfqName, data]) => {
                    const rankedReports = getRankedReports(data.allReports);
                    return (
                        <div key={rfqName} className="p-5 bg-slate-700/50 rounded-xl border border-slate-600 shadow-lg">
                            <h3 className="text-lg font-extrabold text-amber-400 mb-4 border-b border-slate-600 pb-2">
                                {rfqName} <span className="text-sm font-normal text-slate-400">({data.count} Total Bids Audited)</span>
                            </h3>
                            <div className="space-y-3">
                                {rankedReports.map((report) => (
                                    <div key={report.id} className={`p-3 rounded-lg border border-slate-600 bg-slate-900/50 space-y-2 flex justify-between items-center transition hover:bg-slate-700/50`} >
                                        <div className='flex items-center min-w-0 cursor-pointer' onClick={() => loadReportFromHistory(report)}>
                                            <div className="text-xl font-extrabold text-amber-500 w-8 flex-shrink-0">
                                                #{report.rank}
                                            </div>
                                            <div className='min-w-0'>
                                                <p className="text-sm font-medium text-white truncate">{report.bidName}</p>
                                                <p className="text-xs text-slate-400">
                                                    Score: <span className="font-bold text-amber-300">{report.percentage}%</span>
                                                    {/* Display the owner's email for ADMIN view */}
                                                    {currentUser?.role === 'ADMIN' && report.userEmail && 
                                                        <span className="ml-2 italic text-slate-500">by {report.userEmail}</span>
                                                    }
                                                </p>
                                            </div>
                                        </div>
                                        <div className='flex space-x-2 flex-shrink-0'>
                                            <span className="text-xs text-slate-500 hidden sm:block">{new Date(report.timestamp).toLocaleDateString()}</span>
                                            <button
                                                onClick={() => loadReportFromHistory(report)}
                                                className="flex items-center px-3 py-1 text-xs font-semibold rounded-lg text-slate-900 bg-amber-500 hover:bg-amber-400 transition"
                                            >
                                                <ArrowLeft className="w-3 h-3 mr-1 rotate-180"/> Load
                                            </button>
                                            {/* Delete Button - ONLY RENDERED FOR ADMIN */}
                                            {currentUser?.role === 'ADMIN' && (
                                                <button
                                                    onClick={() => deleteReport(report.id, report.rfqName, report.bidName)}
                                                    className="flex items-center px-4 py-2 text-xs font-semibold rounded-lg text-white bg-red-600 hover:bg-red-500 transition shadow-md"
                                                    title="Click to Delete Report Permanently"
                                                >
                                                    <Trash2 className="w-3 h-3 mr-1"/> Delete
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// --- ReportHistory Component ---
const ReportHistory = ({ reportsHistory, loadReportFromHistory, deleteReport, isAuthReady, userId, setCurrentPage, currentUser }) => {
    // Note: The history data is now pre-filtered/collected based on user role in the App component.
    
    // Redirect unauthenticated users
    if (!userId || !isAuthReady) {
        return (
            <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl shadow-black/50 border border-slate-700">
                <p className="text-xl text-red-400 font-bold mb-4">Access Denied</p>
                <p className="text-slate-300 mb-6">Please log in to view your saved reports.</p>
                <button onClick={() => setCurrentPage(PAGE.HOME)} className="flex items-center px-4 py-2 text-sm font-semibold rounded-lg text-slate-900 bg-amber-500 hover:bg-amber-400 transition">
                    <LogIn className="w-4 h-4 mr-1"/> Go to Login
                </button>
            </div>
        );
    }

    const handleBack = () => {
        if (currentUser && currentUser.role === 'ADMIN') {
            setCurrentPage(PAGE.ADMIN); // Admins go back to their dashboard
        } else if (currentUser) {
            setCurrentPage(PAGE.COMPLIANCE_CHECK); // Standard users go to the check page
        } else {
            setCurrentPage(PAGE.HOME); // Fallback to home/login
        }
    };
    
    return (
        <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl shadow-black/50 border border-slate-700">
            <div className="flex justify-between items-center mb-6 border-b border-slate-700 pb-3">
                <h2 className="text-xl font-bold text-white flex items-center">
                    <Clock className="w-5 h-5 mr-2 text-amber-500"/> Saved Report History ({reportsHistory.length})
                </h2>
                <button onClick={handleBack} className="text-sm text-slate-400 hover:text-amber-500 flex items-center">
                    <ArrowLeft className="w-4 h-4 mr-1"/> Back to Dashboard
                </button>
            </div>
            
            <ComplianceRanking 
                reportsHistory={reportsHistory} 
                loadReportFromHistory={loadReportFromHistory} 
                deleteReport={deleteReport} 
                currentUser={currentUser}
            />

        </div>
    );
};

// --- AdminDashboard Component ---
const AdminDashboard = ({ setCurrentPage, currentUser, usageLimits, reportsHistory, allUserProfiles }) => {
    const totalAudits = (usageLimits.initiatorChecks || 0) + (usageLimits.bidderChecks || 0);
    const totalUsers = allUserProfiles.length;
    const recentReports = reportsHistory.slice(0, 5); // Get 5 most recent

    const handleLogout = () => {
        // Since Firebase Auth is now used, logging out will trigger onAuthStateChanged
        // which will then reset the state and navigate to PAGE.HOME.
        signOut(getAuth()); 
    };

    return (
        <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl shadow-black/50 border border-slate-700 space-y-8">
            <div className="flex justify-between items-center border-b border-slate-700 pb-4">
                <h2 className="text-3xl font-bold text-white flex items-center">
                    <Shield className="w-8 h-8 mr-3 text-red-400"/> Admin System Oversight
                </h2>
                <button onClick={handleLogout} className="text-sm text-slate-400 hover:text-amber-500 flex items-center" > 
                    <ArrowLeft className="w-4 h-4 mr-1"/> Logout 
                </button>
            </div>
            
            <p className="text-lg text-slate-300"> Welcome, <span className="font-bold text-red-300">{currentUser?.name || 'Admin'}</span>. You have full access to all user data and reports. </p>

            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <StatCard 
                    icon={<Users className="w-6 h-6 text-blue-400"/>} 
                    label="Registered Users" 
                    value={totalUsers} 
                />
                <StatCard 
                    icon={<Zap className="w-6 h-6 text-green-400"/>} 
                    label="Total Audits Run" 
                    value={totalAudits} 
                />
                <StatCard 
                    icon={<Clock className="w-6 h-6 text-amber-400"/>} 
                    label="Total Saved Reports" 
                    value={reportsHistory.length} 
                />
            </div>

            {/* Users and Reports Sections */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* User List */}
                <div className="space-y-4">
                    <h3 className="text-xl font-bold text-white border-b border-slate-700 pb-2 flex items-center">
                        <User className="w-5 h-5 mr-2 text-blue-400"/> User Management ({totalUsers})
                    </h3>
                    <div className="max-h-96 overflow-y-auto space-y-3 pr-2">
                        {allUserProfiles.length > 0 ? allUserProfiles.map(user => (
                            <UserProfileCard key={user.uid} user={user} />
                        )) : (
                            <p className="text-slate-400 italic text-sm">No registered user profiles found.</p>
                        )}
                    </div>
                </div>

                {/* Recent Reports */}
                <div className="space-y-4">
                    <h3 className="text-xl font-bold text-white border-b border-slate-700 pb-2 flex items-center">
                        <List className="w-5 h-5 mr-2 text-amber-400"/> Recent System Activity
                    </h3>
                    <div className="space-y-3">
                        {recentReports.length > 0 ? recentReports.map(item => (
                            <div key={item.id} className="flex justify-between items-center p-3 bg-slate-700/50 rounded-lg border border-slate-700">
                                <div>
                                    <p className="text-sm font-medium text-white">{item.bidName}</p>
                                    <p className="text-xs text-slate-400">vs {item.rfqName} <span className='text-xs italic text-slate-500 ml-2'>({item.userEmail})</span></p>
                                </div>
                                <span className="text-xs text-slate-500">{new Date(item.timestamp).toLocaleDateString()}</span>
                            </div>
                        )) : (
                            <p className="text-slate-400 italic text-sm">No saved reports found in the database.</p>
                        )}
                    </div>
                    <button onClick={() => setCurrentPage(PAGE.HISTORY)} className="w-full py-2 text-sm font-semibold rounded-lg text-slate-900 bg-amber-500 hover:bg-amber-400 transition shadow-md mt-4">
                        <Clock className="w-4 h-4 mr-2 inline-block"/> View Full Report History
                    </button>
                    <button onClick={() => setCurrentPage(PAGE.COMPLIANCE_CHECK)} className="w-full py-2 text-sm font-semibold rounded-lg text-white bg-blue-600 hover:bg-blue-500 transition shadow-md mt-2">
                        <Send className="w-4 h-4 mr-2 inline-block"/> Run New Compliance Check
                    </button>
                </div>
            </div>
        </div>
    );
};


// --- Common Audit Component (Usage limits removed) ---
const AuditPage = ({ title, rfqTitle, bidTitle, role, handleAnalyze, usageLimits, setCurrentPage, currentUser, loading, RFQFile, BidFile, setRFQFile, setBidFile, generateTestData, errorMessage, report, saveReport, saving, setErrorMessage, userId }) => {
    
    // --- NEW: Handle Save (Uses userProfile for email) ---
    const handleSave = () => {
        // Pass user's email to save with the report for Admin visibility
        saveReport(role, currentUser?.email); 
    }; 
    
    // --- NEW: Conditional Back Button Logic (Now Logout) ---
    const handleLogout = () => {
        // Log out via Firebase Auth
        signOut(getAuth()); 
        // onAuthStateChanged will handle navigating back to PAGE.HOME
    }; 

    // --- NEW: Conditional Header Message ---
    const HeaderMessage = () => {
        if (currentUser && currentUser.role === 'ADMIN') {
            return (
                <p className="text-red-400 text-sm font-semibold"> 
                    **ADMIN VIEW**: Running audit for testing. <span className='text-slate-400'>({currentUser.name} | {currentUser.company})</span>
                </p>
            );
        } else if (currentUser) {
            return (
                <p className="text-green-400 text-sm font-semibold"> 
                    Welcome, {currentUser.name}. <span className='text-slate-400'>({currentUser.company} | Audits: {usageLimits})</span>
                </p>
            );
        }
        return <p className="text-slate-500 text-sm">Please log in for persistent history and usage tracking.</p>;
    };

    return (
        <div className="bg-slate-800 p-8 rounded-2xl shadow-2xl shadow-black/50 border border-slate-700 space-y-6">
            <div className="flex justify-between items-center border-b border-slate-700 pb-4">
                <h2 className="text-3xl font-bold text-white flex items-center">
                    <Layers className="w-8 h-8 mr-3 text-amber-500"/> {title}
                </h2>
                <div className='flex items-center space-x-3'>
                    {currentUser?.role === 'ADMIN' && (
                        <button onClick={() => setCurrentPage(PAGE.ADMIN)} className="text-sm text-slate-400 hover:text-blue-500 flex items-center">
                            <Shield className="w-4 h-4 mr-1"/> Admin Dashboard
                        </button>
                    )}
                    <button onClick={handleLogout} className="text-sm text-slate-400 hover:text-amber-500 flex items-center">
                        <ArrowLeft className="w-4 h-4 mr-1"/> Logout
                    </button>
                </div>
            </div>
            
            <HeaderMessage />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FileUploader 
                    title={rfqTitle} 
                    file={RFQFile} 
                    setFile={(e) => handleFileChange(e, setRFQFile, setErrorMessage)} 
                    color="blue" 
                    requiredText="The official Request for Quotation document. Accepts: .txt, .pdf, .docx"
                />
                <FileUploader 
                    title={bidTitle} 
                    file={BidFile} 
                    setFile={(e) => handleFileChange(e, setBidFile, setErrorMessage)} 
                    color="green" 
                    requiredText="The document responding to the RFQ. Accepts: .txt, .pdf, .docx"
                />
            </div>
            
            {/* Action Buttons */}
            <div className='flex space-x-4 pt-2'>
                <button 
                    onClick={generateTestData} 
                    disabled={loading}
                    className="flex-grow flex items-center justify-center px-6 py-3 text-sm font-semibold rounded-xl text-slate-900 transition-all shadow-md bg-blue-300 hover:bg-blue-200 disabled:opacity-50"
                >
                    <HardDrive className="h-5 w-5 mr-2" /> Load Test Data
                </button>
                <button 
                    onClick={handleAnalyze} 
                    disabled={loading || !RFQFile || !BidFile} 
                    className={`flex-grow flex items-center justify-center px-8 py-4 text-lg font-semibold rounded-xl text-slate-900 transition-all shadow-xl bg-amber-500 hover:bg-amber-400 shadow-amber-900/50 disabled:opacity-50 `} 
                >
                    {loading ? ( <Loader2 className="animate-spin h-6 w-6 mr-3" /> ) : ( <Send className="h-6 w-6 mr-3" /> )}
                    {loading ? 'ANALYZING COMPLEX DOCUMENTS...' : 'RUN COMPLIANCE AUDIT'}
                </button>
            </div>


            {errorMessage && (
                <div className={`mt-6 p-4 ${errorMessage.includes('Mock documents loaded') ? 'bg-blue-900/40 text-blue-300 border-blue-700' : 'bg-red-900/40 text-red-300 border-red-700'} border rounded-xl flex items-center`}>
                    <AlertTriangle className="w-5 h-5 mr-3"/>
                    <p className="text-sm font-medium">{errorMessage}</p>
                </div>
            )}
            
            {/* Save Button (Conditional) */}
            {report && userId && (
                <div className='flex space-x-4 pt-2'>
                    <button 
                        onClick={handleSave} 
                        disabled={saving} 
                        className="flex-grow w-full flex items-center justify-center px-8 py-3 text-md font-semibold rounded-xl text-white bg-slate-600 hover:bg-slate-500 disabled:opacity-50 transition-all"
                    >
                        <Save className="h-5 w-5 mr-2" /> {saving ? 'SAVING...' : 'SAVE REPORT TO HISTORY'}
                    </button>
                    {/* Go to History Button (Conditional on user logged in) */}
                    <button onClick={() => setCurrentPage(PAGE.HISTORY)} className="flex-grow w-full flex items-center justify-center px-8 py-3 text-md font-semibold rounded-xl text-slate-900 bg-green-400 hover:bg-green-300 transition-all">
                        <Clock className="h-5 w-5 mr-2" /> View History
                    </button>
                </div>
            )}

            {/* Report Viewer */}
            <ReportViewer report={report} RFQFile={RFQFile} BidFile={BidFile} getCompliancePercentage={getCompliancePercentage} />
        </div>
    );
};


// --- Main Application Component (Now called App) ---
function App() {
    // --- STATE ---
    const [RFQFile, setRFQFile] = useState(null);
    const [BidFile, setBidFile] = useState(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [report, setReport] = useState(null); 
    const [errorMessage, setErrorMessage] = useState(null);
    const [currentPage, setCurrentPage] = useState(PAGE.HOME);

    // --- FIREBASE STATE (Mock users REMOVED) ---
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null); 
    const [userId, setUserId] = useState(null); // Firebase Auth UID
    const [userProfile, setUserProfile] = useState(null); // Custom profile data (name, role, company, etc.)
    const [allUserProfiles, setAllUserProfiles] = useState([]); // Admin view
    const [reportsHistory, setReportsHistory] = useState([]);
    const [usageLimits, setUsageLimits] = useState({ 
        initiatorChecks: 0, 
        bidderChecks: 0, 
        isSubscribed: true // Set to TRUE for unlimited testing mode
    });

    // --- EFFECT 1: Firebase Initialization and Auth ---
    useEffect(() => {
        try {
            const firebaseConfig = JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG);
            const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
    
            if (Object.keys(firebaseConfig).length === 0) {
                // Allows component to render in environments without Firebase config
                setIsAuthReady(true);
                return;
            }

            const app = initializeApp(firebaseConfig);
            const newAuth = getAuth(app);
            const newDb = getFirestore(app);

            setDb(newDb);
            setAuth(newAuth); 

            // Sign in only if an initial token is provided (e.g., in a code execution environment)
            const signIn = async () => {
                if (initialAuthToken) {
                    try {
                        await signInWithCustomToken(newAuth, initialAuthToken);
                    } catch (error) {
                        console.error("Firebase Sign-In Failed:", error);
                    }
                }
            };
            signIn();

            // CRITICAL: Monitor real Auth state changes
            const unsubscribeAuth = onAuthStateChanged(newAuth, (user) => {
                const currentUserId = user?.uid || null;
                setUserId(currentUserId);
                if (currentUserId) {
                    // Start fetching user profile
                    // Navigation will happen after profile is loaded (Effect 2)
                    setErrorMessage(`User logged in. Fetching profile for ${user.email}...`);
                } else {
                    setUserProfile(null);
                    setCurrentPage(PAGE.HOME);
                    setErrorMessage(null);
                }
                setIsAuthReady(true);
            });

            return () => unsubscribeAuth();

        } catch (e) {
            console.error("Error initializing Firebase:", e);
            setIsAuthReady(true);
        }
    }, []); 

    // --- EFFECT 2: Load User Profile (Triggers on successful Firebase Auth) ---
    useEffect(() => {
        if (db && userId) {
            const userDocRef = doc(db, 'users', userId);
            
            // Listen to the user profile document
            const unsubscribeProfile = onSnapshot(userDocRef, (docSnap) => {
                if (docSnap.exists()) {
                    const profile = { ...docSnap.data(), uid: userId, email: getAuth().currentUser.email };
                    setUserProfile(profile);

                    // Navigate based on the fetched role
                    if (profile.role === 'ADMIN') {
                        setCurrentPage(PAGE.ADMIN);
                    } else {
                        setCurrentPage(PAGE.COMPLIANCE_CHECK);
                    }
                    setErrorMessage(null); // Clear loading message

                } else {
                    // This should not happen if registration worked, but handles edge case
                    console.warn(`User profile not found for UID: ${userId}.`);
                    setUserProfile(null);
                    // Force log out if profile is missing
                    signOut(getAuth()); 
                }
            }, (error) => {
                console.error("Error listening to user profile:", error);
                setErrorMessage(`Error fetching profile: ${error.message}`);
                setUserProfile(null);
            });

            return () => unsubscribeProfile();
        } else {
            setUserProfile(null);
        }
    }, [db, userId]);

    // --- EFFECT 3: Load/Initialize Usage Limits (Scoped by userId) ---
    useEffect(() => {
        if (db && userId) {
            const docRef = getUsageDocRef(db, userId);

            const unsubscribe = onSnapshot(docRef, (docSnap) => {
                if (docSnap.exists()) {
                    setUsageLimits({
                        ...docSnap.data(),
                        isSubscribed: true // FORCE true for unlimited mode
                    });
                } else {
                    // Initialize document if it doesn't exist
                    const initialData = { 
                        initiatorChecks: 0, 
                        bidderChecks: 0, 
                        isSubscribed: true // FORCE true for unlimited mode
                    };
                    setDoc(docRef, initialData).catch(e => console.error("Error creating usage doc:", e));
                    setUsageLimits(initialData);
                }
            }, (error) => {
                console.error("Error listening to usage limits:", error);
            });

            return () => unsubscribe();
        }
    }, [db, userId]);

    // --- EFFECT 4: Firestore Listener for Report History (Scoped by Role/UID) ---
    useEffect(() => {
        if (db && userProfile) {
            let reportsQuery;
            const appId = typeof __app_id !== 'undefined' ? '__app_id' : 'default-app-id';

            if (userProfile.role === 'ADMIN') {
                // ADMIN: Use collectionGroup to get reports from all users
                // Requires Firestore Index: compliance_reports (collectionId)
                reportsQuery = query(
                    collectionGroup(db, 'compliance_reports'),
                    orderBy('timestamp', 'desc')
                );
            } else {
                // USER: Use a standard collection query scoped to their UID
                const reportsRef = collection(db, `artifacts/${appId}/users/${userId}/compliance_reports`);
                reportsQuery = query(reportsRef, orderBy('timestamp', 'desc'));
            }

            const unsubscribeSnapshot = onSnapshot(reportsQuery, (snapshot) => {
                const history = [];
                snapshot.forEach((doc) => {
                    history.push({ id: doc.id, ...doc.data() });
                });
                setReportsHistory(history);
            }, (error) => {
                console.error("Error listening to reports:", error);
                setErrorMessage(`Error fetching reports: ${error.message}. Check your Firestore security rules and collection group index.`);
            });

            // CRITICAL: onSnapshot re-runs whenever userProfile changes (e.g., role change)
            return () => unsubscribeSnapshot();
        } else {
            setReportsHistory([]);
        }
    }, [db, userProfile]);

    // --- EFFECT 5: Admin User Profile Listener (Only for Admin Dashboard) ---
    useEffect(() => {
        if (db && userProfile?.role === 'ADMIN') {
            const usersRef = collection(db, 'users');
            const q = query(usersRef, limit(50)); // Limit to a reasonable number for demo

            const unsubscribeUsers = onSnapshot(q, (snapshot) => {
                const users = [];
                snapshot.forEach((doc) => {
                    users.push({ uid: doc.id, ...doc.data() });
                });
                setAllUserProfiles(users);
            }, (error) => {
                console.error("Error listening to user profiles:", error);
            });

            return () => unsubscribeUsers();
        } else {
            setAllUserProfiles([]);
        }
    }, [db, userProfile]);

    // --- LOGIC: Increment Usage Count via Transaction (Tracking only, no enforcement) ---
    const incrementUsage = async (roleKey) => {
        if (!db || !userId) return;
        const docRef = getUsageDocRef(db, userId);

        try {
            await runTransaction(db, async (transaction) => {
                const docSnap = await transaction.get(docRef);
                
                let currentData;
                if (!docSnap.exists()) {
                    currentData = { initiatorChecks: 0, bidderChecks: 0, isSubscribed: true };
                    transaction.set(docRef, currentData);
                } else {
                    currentData = docSnap.data();
                }

                const newCount = (currentData[roleKey] || 0) + 1;
                transaction.update(docRef, { [roleKey]: newCount, isSubscribed: true }); // Always set subscribed to true
                
                setUsageLimits(prev => ({
                    ...prev,
                    [roleKey]: newCount
                }));

            });
        } catch (e) {
            console.error("Transaction failed to update usage:", e);
        }
    };


    // --- CORE LOGIC: Compliance Analysis (No change needed) ---
    const handleAnalyze = useCallback(async (role) => {
        const roleKey = role === 'INITIATOR' ? 'initiatorChecks' : 'bidderChecks';
        
        if (!RFQFile || !BidFile) {
            setErrorMessage("Please upload both the RFQ and the Bid documents.");
            return;
        }

        setLoading(true);
        setReport(null);
        setErrorMessage(null);

        try {
            const rfqContent = await processFile(RFQFile);
            const bidContent = await processFile(BidFile);
            
            // --- UPDATED SYSTEM PROMPT (INCLUDING NEGOTIATION STANCE INSTRUCTION) ---
            const systemPrompt = {
                parts: [{
                    text: `You are the SmartBid Compliance Auditor, a world-class procurement specialist. Your task is to strictly compare two documents: the Request for Quotation (RFQ) and the submitted Bid.
                    1. Identify all mandatory requirements, clauses, and constraints from the RFQ.
                    2. For each requirement, locate the corresponding response in the Bid.
                    3. Assign a Compliance Score: 1 for Full Compliance, 0.5 for Partially Addressed, 0 for Non-Compliant/Missing.
                    4. Infer a functional category for each requirement from the following list: ${CATEGORY_ENUM.join(', ')}.
                    5. IMPORTANT: For any item scoring 0 or 0.5 (Non-Compliant or Partial), you MUST generate a 'negotiationStance'. This stance must be a 1-2 sentence compromise that the bidder can use to open negotiations with the client, moving the language closer to the RFQ's intent without changing the bidder's core offering. Omit this field for Compliant findings.
                    6. Generate the output ONLY as a JSON object matching the provided comprehensive schema, ensuring the 'executiveSummary' is informative and actionable.`
                }]
            };

            const userQuery = `RFQ Document Content (Document A - Mandatory Requirements):\n\n---START RFQ---\n${rfqContent}\n---END RFQ---\n\nBid/Proposal Document Content (Document B - The Response):\n\n---START BID---\n${bidContent}\n---END BID---\n\nBased ONLY on the content above, perform the compliance audit and return the results in the requested JSON format.`;

            const payload = {
                contents: [{ parts: [{ text: userQuery }] }],
                systemInstruction: systemPrompt,
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: COMPREHENSIVE_REPORT_SCHEMA
                },
            };

            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            };

            const response = await fetchWithRetry(API_URL, options);
            const result = await response.json();
            
            const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;

            if (jsonText) {
                const parsedReport = JSON.parse(jsonText); 
                setReport(parsedReport);
                
                // SUCCESS: Increment usage counter (for tracking, not limiting)
                // We use 'bidderChecks' as the generic key for "any compliance check"
                await incrementUsage('bidderChecks');

            } else {
                throw new Error("AI failed to return a valid JSON report.");
            }

        } catch (error) {
            console.error("Analysis Error:", error);
            setErrorMessage(`Failed to generate report. Details: ${error.message}.`);
        } finally {
            setLoading(false);
        }
    }, [RFQFile, BidFile]);


    // --- CORE LOGIC: Test Data Generation ---
    const generateTestData = useCallback(async () => {
        // Mock RFQ content based on the demonstration documents (Risk Weights removed)
        const mockRfqContent = `
1. TECHNICAL: The proposed cloud solution must integrate bi-directionally with our legacy billing system via its existing REST/JSON API endpoints, as detailed in Appendix B. This is a mandatory core technical specification.
2. FINANCIAL: Bidders must submit a Firm Fixed Price (FFP) quote for all services covering the first 12 calendar months of operation. Cost estimates or time-and-materials pricing will result in non-compliance.
3. LEGAL: A signed, legally binding Non-Disclosure Agreement (NDA) must be included as a separate document, titled "Appendix A," within the submission package.
4. TIMELINE: The entire migration project, including final testing and sign-off, must be completed and live within 60 calendar days of contract award.
5. ADMINISTRATIVE: The entire bid package (including all appendices) must be submitted electronically as a single, consolidated PDF document.
        `.trim();
        
        // Mock Bid content based on the demonstration documents (with deliberate compliance issues)
        const mockBidContent = `
--- EXECUTIVE SUMMARY ---
We are pleased to submit our proposal for the Cloud Migration Service. We are committed to a successful partnership.

--- TECHNICAL RESPONSE ---
1. Technical Integration: We propose using our cutting-edge GraphQL gateway for integration, as it offers superior flexibility. While we prefer GraphQL, we understand the requirement for REST/JSON integration with the legacy billing system. We can certainly look into developing the necessary REST/JSON adaptors during the implementation phase, contingent upon a change order if complexity is higher than anticipated.

--- FINANCIALS ---
2. Financials: We have outlined our estimated costs for the first 12 months in the following table. Our estimated price is $850,000. This estimate is subject to final scoping validation but provides a clear indication of cost.

--- LEGAL COMPLIANCE ---
3. Legal: We are happy to execute the NDA referenced in your RFQ. We have executed it and it is included on page 10 of this document.

--- TIMELINE ---
4. Timeline: We estimate a 90-day completion timeline, given the current resource allocation specified for project completion.

--- ADMINISTRATIVE ---
5. Submission Format: We confirm that this document, along with all supporting materials, has been consolidated and submitted as a single PDF file for your review.
        `.trim();

        // Clear existing files and report
        setRFQFile(null);
        setBidFile(null);
        setReport(null);
        setLoading(true);
        setErrorMessage(null);

        try {
            const mockRFQFile = new File([mockRfqContent], "MOCK_RFQ_SIMPLIFIED.txt", { type: "text/plain" });
            const mockBidFile = new File([mockBidContent], "MOCK_BID_SIMPLIFIED.txt", { type: "text/plain" });
            setRFQFile(mockRFQFile);
            setBidFile(mockBidFile);
            setErrorMessage("Mock documents loaded! Click 'RUN COMPLIANCE AUDIT' to see the Standard Score.");
        } catch (error) {
            console.error("Test Data Generation Error:", error);
            setErrorMessage(`Failed to generate test data: ${error.message}`);
        } finally {
            setLoading(false);
        }
    }, []);

    // --- CORE LOGIC: Save Report ---
    const saveReport = useCallback(async (role, userEmail) => {
        if (!db || !userId || !report) {
            setErrorMessage("Database not ready or no report to save.");
            return;
        }
        setSaving(true);
        try {
            const appId = typeof __app_id !== 'undefined' ? '__app_id' : 'default-app-id';
            const reportsRef = collection(db, `artifacts/${appId}/users/${userId}/compliance_reports`);

            await addDoc(reportsRef, { 
                ...report, 
                rfqName: RFQFile?.name || 'Untitled RFQ', 
                bidName: BidFile?.name || 'Untitled Bid', 
                timestamp: Date.now(), 
                role: role, // Save the role used for the audit
                // CRITICAL: Save user ID and Email for admin lookup
                userId: userId, 
                userEmail: userEmail,
            }); 
            setErrorMessage("Report saved successfully to history!");
            setTimeout(() => setErrorMessage(null), 3000);
        } catch (error) {
            console.error("Error saving report:", error);
            setErrorMessage(`Failed to save report: ${error.message}`);
        } finally {
            setSaving(false);
        }
    }, [db, userId, report, RFQFile, BidFile, userProfile]);

    // --- CORE LOGIC: Load Report from History ---
    const loadReportFromHistory = (report) => {
        // Reset file state to null to avoid confusion, since the content is not loaded
        setRFQFile({ name: report.rfqName });
        setBidFile({ name: report.bidName });
        setReport(report);
        setErrorMessage(`Loaded report: ${report.bidName} vs ${report.rfqName}`);
        setCurrentPage(PAGE.COMPLIANCE_CHECK);
    };

    // --- CORE LOGIC: Delete Report ---
    const deleteReport = useCallback(async (reportId, rfqName, bidName) => {
        if (!db || !userProfile || userProfile.role !== 'ADMIN') {
            setErrorMessage("Access denied. Only Admins can delete reports.");
            return;
        }
        setErrorMessage(`Deleting report: ${rfqName} vs ${bidName}...`);
        
        try {
            const appId = typeof __app_id !== 'undefined' ? '__app_id' : 'default-app-id';
            // Find the original user ID from the reportsHistory to get the correct path
            const reportToDelete = reportsHistory.find(r => r.id === reportId);
            if (!reportToDelete || !reportToDelete.userId) {
                 throw new Error("Report data missing original user ID for deletion path.");
            }
            
            const reportsRef = collection(db, `artifacts/${appId}/users/${reportToDelete.userId}/compliance_reports`);
            const docRef = doc(reportsRef, reportId); 
            
            await deleteDoc(docRef);

            // Clear any currently loaded report if it's the one being deleted
            if (report && report.id === reportId) {
                setReport(null);
            }

            setErrorMessage(`Report '${reportId}' deleted successfully!`);
            setTimeout(() => setErrorMessage(null), 3000);
            
        } catch (error) {
            console.error("Error deleting report:", error);
            setErrorMessage(`Failed to delete report: ${error.message}`);
        }
    }, [db, report, reportsHistory, userProfile]);

    // --- Logout Handler (Used by AuditPage and AdminDashboard) ---
    // Note: The main logout logic is inside the button's onClick (signOut(getAuth())), 
    // and the onAuthStateChanged listener handles the state transition.


    // --- Clear File Helper ---
    const handleClearFiles = () => {
        setRFQFile(null);
        setBidFile(null);
        setReport(null);
        setErrorMessage(null);
    };

    // --- Render Switch ---
    const renderPage = () => {
        // Guard against uninitialized state (Firebase may take a moment to set userId)
        if (!isAuthReady || (userId && !userProfile && currentPage !== PAGE.HOME)) {
             // If we have a userId but no profile, it means we are fetching. Show a loading screen.
             return (
                 <div className="min-h-screen flex flex-col items-center justify-center text-center text-white p-8">
                     <Loader2 className="animate-spin h-12 w-12 text-amber-500 mb-4"/>
                     <h2 className='text-xl font-bold'>Loading User Profile...</h2>
                     <p className='text-slate-400'>Establishing secure session and fetching role data.</p>
                 </div>
             );
        }

        switch (currentPage) {
            case PAGE.HOME:
                return <AuthPage 
                    setCurrentPage={setCurrentPage} 
                    setErrorMessage={setErrorMessage} 
                    isAuthReady={isAuthReady} 
                    errorMessage={errorMessage} 
                    auth={auth} // Pass Firebase Auth instance
                    db={db}    // Pass Firestore instance
                    setUserProfile={setUserProfile} // Function to update profile state
                    userId={userId}
                />;
            case PAGE.COMPLIANCE_CHECK:
                // Redirect unauthenticated users back to login
                if (!userId) return <AuthPage setCurrentPage={setCurrentPage} setErrorMessage={setErrorMessage} isAuthReady={isAuthReady} errorMessage={errorMessage} auth={auth} db={db} setUserProfile={setUserProfile} userId={userId} />;
                
                return <AuditPage 
                    title="Bidder: Self-Compliance Check" 
                    rfqTitle="Request for Quotation (RFQ)" 
                    bidTitle="Bid/Proposal Document" 
                    role="BIDDER" 
                    handleAnalyze={handleAnalyze} 
                    usageLimits={usageLimits.bidderChecks} 
                    setCurrentPage={setCurrentPage} 
                    currentUser={userProfile} // Pass the logged-in profile
                    loading={loading} 
                    RFQFile={RFQFile} 
                    BidFile={BidFile} 
                    setRFQFile={setRFQFile} 
                    setBidFile={setBidFile} 
                    generateTestData={generateTestData} 
                    errorMessage={errorMessage} 
                    report={report} 
                    saveReport={saveReport} 
                    saving={saving} 
                    setErrorMessage={setErrorMessage} 
                    userId={userId} 
                />;
            case PAGE.ADMIN:
                // Redirect if not admin
                if (userProfile?.role !== 'ADMIN') return <AuthPage setCurrentPage={setCurrentPage} setErrorMessage={setErrorMessage} isAuthReady={isAuthReady} errorMessage={errorMessage} auth={auth} db={db} setUserProfile={setUserProfile} userId={userId} />;

                return <AdminDashboard 
                    setCurrentPage={setCurrentPage} 
                    currentUser={userProfile} 
                    usageLimits={usageLimits} 
                    reportsHistory={reportsHistory}
                    allUserProfiles={allUserProfiles} // Pass fetched profiles
                />;
            case PAGE.HISTORY:
                 // Redirect unauthenticated users back to login
                if (!userId) return <AuthPage setCurrentPage={setCurrentPage} setErrorMessage={setErrorMessage} isAuthReady={isAuthReady} errorMessage={errorMessage} auth={auth} db={db} setUserProfile={setUserProfile} userId={userId} />;

                return <ReportHistory 
                    reportsHistory={reportsHistory} 
                    loadReportFromHistory={loadReportFromHistory} 
                    deleteReport={deleteReport} 
                    isAuthReady={isAuthReady} 
                    userId={userId} 
                    setCurrentPage={setCurrentPage} 
                    currentUser={userProfile} 
                />;
            default:
                return <AuthPage setCurrentPage={setCurrentPage} setErrorMessage={setErrorMessage} isAuthReady={isAuthReady} errorMessage={errorMessage} auth={auth} db={db} setUserProfile={setUserProfile} userId={userId} />;
        }
    };

    return (
        <div className="min-h-screen bg-slate-900 font-body p-4 sm:p-8 text-slate-100">
            <style>{`
                /* --- FONT UPDATE: Lexend --- */
                @import url('https://fonts.googleapis.com/css2?family=Lexend:wght@100..900&display=swap');
                /* Apply Lexend to all font utility classes */
                .font-body, .font-body *, .font-display, .font-display * {
                    font-family: 'Lexend', sans-serif !important;
                }
                
                input[type="file"] {
                    display: block;
                    width: 100%;
                }
                
                input[type="file"]::file-selector-button {
                    /* Custom styles for the file button */
                    background-color: #f59e0b; /* amber-500 */
                    color: #1e293b; /* slate-900 */
                    border: none;
                    padding: 8px 16px;
                    border-radius: 8px;
                    font-weight: 600;
                    cursor: pointer;
                    margin-right: 16px;
                    transition: background-color 0.2s;
                }
                
                input[type="file"]::file-selector-button:hover {
                    background-color: #fbbf24; /* amber-400 */
                }
            `}</style>
            
            {/* Header / Navigation Bar */}
            <div className="flex justify-between items-center py-4 px-6 bg-slate-800 rounded-xl shadow-lg border border-slate-700 mb-6">
                <div className='flex items-center space-x-3 cursor-pointer' onClick={() => setCurrentPage(userProfile?.role === 'ADMIN' ? PAGE.ADMIN : (userId ? PAGE.COMPLIANCE_CHECK : PAGE.HOME))}>
                    <Zap className="w-8 h-8 text-amber-500"/>
                    <h1 className="text-2xl font-extrabold text-white font-display">SmartBid<span className="text-amber-500">Compliance</span></h1>
                </div>

                <nav className="flex items-center space-x-4">
                    {userId && (
                        <>
                            {userProfile?.role === 'ADMIN' && (
                                <button onClick={() => setCurrentPage(PAGE.ADMIN)} className={`text-sm font-semibold transition-colors ${currentPage === PAGE.ADMIN ? 'text-red-400 border-b-2 border-red-400' : 'text-slate-400 hover:text-red-300'}`}>
                                    <Shield className="w-4 h-4 mr-1 inline-block"/> Admin
                                </button>
                            )}
                            <button onClick={() => setCurrentPage(PAGE.COMPLIANCE_CHECK)} className={`text-sm font-semibold transition-colors ${currentPage === PAGE.COMPLIANCE_CHECK ? 'text-amber-400 border-b-2 border-amber-400' : 'text-slate-400 hover:text-amber-300'}`}>
                                <Send className="w-4 h-4 mr-1 inline-block"/> Audit
                            </button>
                            <button onClick={() => setCurrentPage(PAGE.HISTORY)} className={`text-sm font-semibold transition-colors ${currentPage === PAGE.HISTORY ? 'text-blue-400 border-b-2 border-blue-400' : 'text-slate-400 hover:text-blue-300'}`}>
                                <Clock className="w-4 h-4 mr-1 inline-block"/> History
                            </button>
                            <button onClick={() => signOut(getAuth())} className="text-sm font-semibold text-slate-400 hover:text-red-400 flex items-center">
                                <LogIn className="w-4 h-4 mr-1"/> Logout
                            </button>
                        </>
                    )}
                    {!userId && (
                        <button onClick={() => setCurrentPage(PAGE.HOME)} className={`text-sm font-semibold transition-colors ${currentPage === PAGE.HOME ? 'text-green-400 border-b-2 border-green-400' : 'text-slate-400 hover:text-green-300'}`}>
                            <LogIn className="w-4 h-4 mr-1 inline-block"/> Login
                        </button>
                    )}
                </nav>
            </div>
            
            {/* Main Content Area */}
            <main>
                {renderPage()}
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
