import { useState, useEffect } from "react";
import { User, LogOut, XCircle, Settings, AlertTriangle } from "lucide-react";
import { useAuthContext } from "../../context/AuthContext";
import { API_ENDPOINTS } from "../../constants/network";
import "./ProfileScreen.css";

const FIFTEEN_SECONDS = 0.25 * 60 * 1000;

const getLevelTitle = (level) => {
  if (level >= 10) return "Master Mapper";
  if (level >= 5)  return "Local Guide";
  if (level >= 3)  return "Expert Navigator";
  return "Rookie Courier";
};

const formatEndDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
};

export default function ProfileScreen({ onBack }) {
  const { user, token, logout } = useAuthContext();
  const [profile, setProfile] = useState(user);
  const [error, setError]     = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // ── Cancel-subscription flow ────────────────────────────────────────────
  // step: 'idle' | 'settings' | 'confirm' | 'otp'
  // 'settings' - hidden settings section where cancellation is buried
  // 'confirm' - asks "are you sure" before sending code
  // 'otp' - shown after request-cancellation-otp succeeds, actually cancels
  const [cancelStep, setCancelStep] = useState("idle");
  const [cancelOtp, setCancelOtp] = useState("");
  const [cancelError, setCancelError] = useState(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelInfo, setCancelInfo] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCancelOption, setShowCancelOption] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [showDangerZone, setShowDangerZone] = useState(false);

  const PROFILE_CACHE_KEY = `profile_${user?.id || user?._id}`;

  // ── Step 1: load from localStorage cache immediately ──────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROFILE_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setProfile(parsed.data ?? parsed);
      }
    } catch (_) {}
  }, []);

  // ── Step 2: fetch fresh data if cache is stale ────────────────────────────
  useEffect(() => {
    if (!token || !user) return;

    const fetchProfile = async () => {
      try {
        const raw = localStorage.getItem(PROFILE_CACHE_KEY);
        if (raw) {
          const { timestamp } = JSON.parse(raw);
          if (Date.now() - timestamp < FIFTEEN_SECONDS) return;
        }
      } catch (_) {}

      try {
        const res = await fetch(API_ENDPOINTS.AUTH_ME, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();

        if (!res.ok) {
          if (res.status === 401) {
            localStorage.removeItem(PROFILE_CACHE_KEY);
            logout();
            return;
          }
          throw new Error(data.message || "Failed to fetch profile.");
        }

        setProfile(data);
        localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
      } catch (err) {
        setError(err.message || "Could not load profile data.");
      }
    };

    fetchProfile();
  }, [token]);

  const handleLogout = () => setShowConfirm(true);

  const confirmLogout = () => {
    localStorage.removeItem(PROFILE_CACHE_KEY);
    logout();
  };

  // Persists a patch to the cached profile
  const patchProfileCache = (patch) => {
    setProfile((prev) => {
      const updated = { ...(prev || {}), ...patch };
      try {
        localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ data: updated, timestamp: Date.now() }));
      } catch (_) {}
      return updated;
    });
  };

  // ── Hidden cancellation flow (multi-step, buried) ──────────────────────
  const openSettings = () => {
    setShowSettings(true);
    setCancelStep("settings");
    setShowCancelOption(false);
    setShowDangerZone(false);
    setConfirmText("");
    setCancelError(null);
    setCancelInfo(null);
    setCancelOtp("");
  };

  const closeSettings = () => {
    setShowSettings(false);
    setCancelStep("idle");
    setShowCancelOption(false);
    setShowDangerZone(false);
    setConfirmText("");
    setCancelError(null);
    setCancelInfo(null);
    setCancelOtp("");
  };

  // Step 1: Show hidden cancel option (needs to be clicked 3 times)
  const handleSettingsClick = () => {
    if (!showCancelOption) {
      setShowCancelOption(true);
      setTimeout(() => setShowCancelOption(false), 3000); // Hides again after 3 seconds
    }
  };

  // Step 2: Show danger zone (requires typing confirmation)
  const showDangerZoneHandler = () => {
    if (showCancelOption) {
      setShowDangerZone(true);
      setShowCancelOption(false);
    }
  };

  // Step 3: Confirm cancellation intent (requires typing "cancel")
  const handleConfirmIntent = () => {
    if (confirmText.toLowerCase() === "cancel") {
      setCancelStep("confirm");
      setShowDangerZone(false);
      setConfirmText("");
    } else {
      setCancelError('Please type "cancel" to confirm');
      setTimeout(() => setCancelError(null), 3000);
    }
  };

  // Step 4: Request OTP
  const requestCancellationOtp = async () => {
    setCancelLoading(true);
    setCancelError(null);
    try {
      const res = await fetch(API_ENDPOINTS.REQUEST_CANCELLATION_OTP, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Could not send confirmation code.");
      setCancelInfo(data.message || "A confirmation code has been sent to your email.");
      setCancelStep("otp");
    } catch (err) {
      setCancelError(err.message || "Could not send confirmation code.");
    } finally {
      setCancelLoading(false);
    }
  };

  // Step 5: Verify code and cancel
  const confirmCancellation = async () => {
    if (!cancelOtp.trim()) {
      setCancelError("Enter the code from your email.");
      return;
    }
    setCancelLoading(true);
    setCancelError(null);
    try {
      const res = await fetch(API_ENDPOINTS.CONFIRM_CANCELLATION, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ otp: cancelOtp.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Could not confirm cancellation.");

      patchProfileCache({
        subscriptionStatus: data.subscriptionStatus || "canceled",
        subscriptionEndsAt: data.subscriptionEndsAt || null,
      });
      closeSettings();
    } catch (err) {
      setCancelError(err.message || "Could not confirm cancellation.");
    } finally {
      setCancelLoading(false);
    }
  };

  if (!user) return null;

  const dp = profile || user;
  const contributions = dp.contributions || 0;
  const likesReceived = dp.totalLikesReceived || 0;
  const isActiveSubscription = dp.subscriptionStatus === "active";
  const isCanceledSubscription = dp.subscriptionStatus === "canceled";

  return (
    <div className="ps-root">

      {/* Confirm logout dialog */}
      {showConfirm && (
        <div className="ps-overlay">
          <div className="ps-dialog">
            <h3 className="ps-dialog-title">Logout</h3>
            <p className="ps-dialog-msg">Are you sure you want to logout?</p>
            <div className="ps-dialog-actions">
              <button className="ps-dialog-cancel" onClick={() => setShowConfirm(false)}>Cancel</button>
              <button className="ps-dialog-confirm" onClick={confirmLogout}>Logout</button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden Settings Panel */}
      {showSettings && (
        <div className="ps-overlay">
          <div className="ps-dialog ps-settings-dialog">
            <h3 className="ps-dialog-title">Settings</h3>
            
            {/* Step 1: Hidden cancel option (must click settings text 3 times) */}
            {cancelStep === "settings" && !showDangerZone && (
              <>
                <div 
                  className="ps-hidden-trigger"
                  onClick={handleSettingsClick}
                  onDoubleClick={showDangerZoneHandler}
                >
                  <p className="ps-settings-text">
                    Account Settings
                    {showCancelOption && <span className="ps-hidden-hint"> (Click again to continue)</span>}
                  </p>
                  {showCancelOption && (
                    <button 
                      className="ps-cancel-hidden-btn"
                      onClick={showDangerZoneHandler}
                    >
                      <AlertTriangle size={16} />
                      <span>Manage Subscription</span>
                    </button>
                  )}
                </div>
                
                <div className="ps-settings-divider" />
                
                <button 
                  className="ps-dialog-cancel ps-close-settings"
                  onClick={closeSettings}
                >
                  Close
                </button>
              </>
            )}

            {/* Step 2: Danger zone - requires typing "cancel" */}
            {showDangerZone && (
              <>
                <div className="ps-danger-zone">
                  <h4 className="ps-danger-title">
                    <AlertTriangle size={18} color="#dc3545" />
                    Danger Zone
                  </h4>
                  <p className="ps-danger-text">
                    This action cannot be undone. Please type <strong>"cancel"</strong> below to proceed.
                  </p>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder='Type "cancel" to continue'
                    className="ps-danger-input"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && confirmText.toLowerCase() === "cancel") {
                        handleConfirmIntent();
                      }
                    }}
                  />
                  {cancelError && (
                    <p className="ps-error-text">{cancelError}</p>
                  )}
                  <div className="ps-danger-actions">
                    <button 
                      className="ps-dialog-cancel" 
                      onClick={() => {
                        setShowDangerZone(false);
                        setShowCancelOption(true);
                      }}
                    >
                      Back
                    </button>
                    <button 
                      className="ps-danger-confirm-btn"
                      onClick={handleConfirmIntent}
                      disabled={confirmText.toLowerCase() !== "cancel"}
                    >
                      Continue
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Step 3: Final confirmation before OTP */}
            {cancelStep === "confirm" && (
              <>
                <p className="ps-dialog-msg">
                  We'll email you a confirmation code first for security — please enter the code to cancel your subscription.
                </p>
                {cancelError && (
                  <p className="ps-error-text">{cancelError}</p>
                )}
                <div className="ps-dialog-actions">
                  <button 
                    className="ps-dialog-cancel" 
                    onClick={() => {
                      setCancelStep("settings");
                      setShowDangerZone(true);
                    }} 
                    disabled={cancelLoading}
                  >
                    Back
                  </button>
                  <button 
                    className="ps-dialog-confirm" 
                    onClick={requestCancellationOtp} 
                    disabled={cancelLoading}
                  >
                    {cancelLoading ? "Sending…" : "Send code"}
                  </button>
                </div>
              </>
            )}

            {/* Step 4: OTP entry */}
            {cancelStep === "otp" && (
              <>
                <h3 className="ps-dialog-title">Enter Confirmation Code</h3>
                {cancelInfo && (
                  <p className="ps-dialog-msg">{cancelInfo}</p>
                )}
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={cancelOtp}
                  onChange={(e) => setCancelOtp(e.target.value.replace(/\D/g, ""))}
                  placeholder="6-digit code"
                  className="ps-otp-input"
                />
                {cancelError && (
                  <p className="ps-error-text">{cancelError}</p>
                )}
                <div className="ps-dialog-actions">
                  <button 
                    className="ps-dialog-cancel" 
                    onClick={() => {
                      setCancelStep("confirm");
                      setCancelOtp("");
                    }} 
                    disabled={cancelLoading}
                  >
                    Back
                  </button>
                  <button 
                    className="ps-dialog-confirm" 
                    onClick={confirmCancellation} 
                    disabled={cancelLoading}
                  >
                    {cancelLoading ? "Confirming…" : "Confirm Cancellation"}
                  </button>
                </div>
                <button
                  onClick={requestCancellationOtp}
                  disabled={cancelLoading}
                  className="ps-resend-btn"
                >
                  Resend code
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="ps-inner">
        <h1 className="ps-screen-title">My Profile</h1>

        {error && <div className="ps-error-banner">{error}</div>}

        {/* ── Avatar card ── */}
        <div className="ps-profile-summary">
          <div className="ps-avatar">
            <User size={60} color="#2563eb" />
          </div>
          <p className="ps-name">{dp.name}</p>
          <p className="ps-level">Level {dp.level}: {getLevelTitle(dp.level)}</p>
          <p className="ps-email">{dp.email || ""}</p>
        </div>

        {/* ── Stats ── */}
        <h2 className="ps-section-title" style={{ marginTop: 20 }}>Contribution Statistics</h2>
        <div className="ps-stats">
          <div className="ps-stat-box">
            <span className="ps-stat-number">{contributions}</span>
            <span className="ps-stat-label">Contributions</span>
          </div>
          <div className="ps-stat-box">
            <span className="ps-stat-number">{dp.level}</span>
            <span className="ps-stat-label">Current Level</span>
          </div>
          <div className="ps-stat-box">
            <span className="ps-stat-number">{likesReceived}</span>
            <span className="ps-stat-label">Likes Received</span>
          </div>
        </div>

        {/* ── Badges ── */}
        {dp.badges && dp.badges.length > 0 && (
          <>
            <h2 className="ps-section-title">Earned Badges</h2>
            <div className="ps-badges">
              {dp.badges.map((badge, i) => (
                <span key={i} className="ps-badge">{badge}</span>
              ))}
            </div>
          </>
        )}

        {/* ── Subscription Status (read-only, no cancel button visible) ── */}
        {(isActiveSubscription || isCanceledSubscription) && (
          <>
            <h2 className="ps-section-title" style={{ marginTop: 20 }}>Subscription</h2>
            {isCanceledSubscription ? (
              <p style={{ color: "#6b7280", fontSize: 14 }}>
                Your subscription has been canceled.
                {formatEndDate(dp.subscriptionEndsAt)
                  ? ` You will continue to have full access to the app until the end of your current billing cycle on ${formatEndDate(dp.subscriptionEndsAt)}.`
                  : " You will continue to have full access to the app until the end of your current billing cycle."}
              </p>
            ) : (
              <p style={{ color: "#10b981", fontSize: 14, fontWeight: 500 }}>
                ✓ Active subscription
              </p>
            )}
          </>
        )}

        {/* ── Hidden Settings Trigger (tiny, hard to notice) ── */}
        <div className="ps-settings-trigger">
          <button 
            className="ps-settings-btn"
            onClick={openSettings}
            aria-label="Settings"
          >
            <Settings size={14} color="#9ca3af" />
          </button>
          <span className="ps-settings-label">Preferences</span>
        </div>

        {/* ── Logout ── */}
        <button className="ps-logout-btn" onClick={handleLogout}>
          <LogOut size={20} color="#fff" />
          <span>Logout</span>
        </button>

        <div style={{ height: 50 }} />
      </div>
    </div>
  );
}
