import { useMemo, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { AuthApi } from '../hooks/useAuth.ts';
import { CardView } from '../components/CardView.tsx';

type Mode = 'login' | 'register';

/** 0-4 score: length, mixed case, digits, symbols. Only a hint; the server enforces the real rules. */
function strength(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}
const STRENGTH_LABEL = ['خیلی ضعیف', 'ضعیف', 'متوسط', 'خوب', 'عالی'];

export function AuthPage({ auth }: { auth: AuthApi }) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const score = useMemo(() => strength(password), [password]);
  const mismatch = mode === 'register' && confirm.length > 0 && confirm !== password;

  const fail = (message: string) => { setError(message); setErrorKey((k) => k + 1); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const clean = username.trim();
    if (clean.length < 3) return fail('نام کاربری باید حداقل ۳ کاراکتر باشد.');
    if (password.length < 8) return fail('رمز عبور باید حداقل ۸ کاراکتر باشد.');
    if (mode === 'register' && password !== confirm) return fail('تکرار رمز عبور یکسان نیست.');
    setBusy(true);
    const res = mode === 'login' ? await auth.login(clean, password) : await auth.register(clean, password);
    setBusy(false);
    if (!res.ok) return fail(res.error ?? 'عملیات ناموفق بود.');
    setDone(true);
  };

  const switchMode = (next: Mode) => { setMode(next); setError(null); setConfirm(''); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') ?? false);

  // The card glows where the pointer is.
  const onMove = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--px', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--py', `${e.clientY - r.top}px`);
  };

  return (
    <main className="auth-page">
      <div className="auth-stage">
        <header className="auth-hero">
          <div className="auth-hero__cards" aria-hidden>
            {(['diamond', 'gold', 'camel', 'spice', 'cloth'] as const).map((t, i) => (
              <CardView key={t} card={{ id: `auth-${t}`, type: t }} flip={false} className="auth-hero__card" style={{ ['--i' as string]: i - 2 }} />
            ))}
          </div>
          <p className="eyebrow">JAIPUR ONLINE</p>
          <h1 className="auth-hero__title brand--shine">Jaipur</h1>
          <p className="auth-hero__tag">بازار شهر صورتی منتظر توست؛ تجارت کن، رقیب را شکست بده.</p>
        </header>

        <section className={`auth-card ${done ? 'is-done' : ''}`} aria-label={mode === 'login' ? 'ورود' : 'ثبت نام'} onPointerMove={onMove}>
          <span className="auth-card__edge" aria-hidden />
          <span className="auth-card__shine" aria-hidden />

          <div className="seg" role="tablist" aria-label="ورود یا ثبت نام" data-mode={mode}>
            <span className="seg__thumb" aria-hidden />
            <button type="button" role="tab" aria-selected={mode === 'login'} className="seg__btn" onClick={() => switchMode('login')}>ورود</button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className="seg__btn" onClick={() => switchMode('register')}>ثبت‌نام</button>
          </div>

          <h2 className="auth-card__title" key={mode}>{mode === 'login' ? 'به بازار جِیپور برگرد' : 'حساب بازی بساز'}</h2>
          <p className="auth-card__sub">حساب شما بازی‌ها، امتیازها و سابقه‌تان را نگه می‌دارد.</p>

          <form onSubmit={submit} className="auth-form" noValidate>
            <label className="field">
              <span className="field__label">نام کاربری</span>
              <span className="input-wrap">
                <span className="input-wrap__icon" aria-hidden>👤</span>
                <input className="input input--icon" value={username} maxLength={24} autoComplete="username" autoCapitalize="none" spellCheck={false} dir="ltr" placeholder="your_username" onChange={(e) => setUsername(e.target.value)} />
              </span>
            </label>

            <label className="field">
              <span className="field__label">رمز عبور</span>
              <span className="input-wrap">
                <span className="input-wrap__icon" aria-hidden>🔑</span>
                <input className="input input--icon input--eye" value={password} minLength={8} maxLength={128} type={show ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} dir="ltr" placeholder="••••••••" onKeyUp={onKey} onKeyDown={onKey} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="input-wrap__eye" onClick={() => setShow((v) => !v)} aria-label={show ? 'پنهان کردن رمز' : 'نمایش رمز'} title={show ? 'پنهان کردن رمز' : 'نمایش رمز'}>{show ? '🙈' : '👁️'}</button>
              </span>
              {caps && <span className="field__warn">⚠️ Caps Lock روشن است</span>}
            </label>

            {mode === 'register' && (
              <>
                <div className="meter" data-score={score} aria-hidden={password.length === 0}>
                  <span className="meter__bars"><i /><i /><i /><i /></span>
                  <span className="meter__label">{password ? `قدرت رمز: ${STRENGTH_LABEL[score]}` : 'رمز قوی = حساب امن‌تر'}</span>
                </div>
                <label className="field">
                  <span className="field__label">تکرار رمز عبور</span>
                  <span className="input-wrap">
                    <span className="input-wrap__icon" aria-hidden>🔒</span>
                    <input className={`input input--icon ${mismatch ? 'is-invalid' : ''}`} value={confirm} minLength={8} maxLength={128} type={show ? 'text' : 'password'} autoComplete="new-password" dir="ltr" placeholder="••••••••" onChange={(e) => setConfirm(e.target.value)} />
                  </span>
                  {mismatch && <span className="field__warn">تکرار رمز با رمز بالا یکی نیست.</span>}
                </label>
              </>
            )}

            <p key={errorKey} className={`form-error ${error ? 'is-shown' : ''}`} role="alert">{error ?? ' '}</p>
            <button className={`btn btn--primary btn--xl btn--glow ${busy ? 'is-busy' : ''}`} type="submit" disabled={busy || done}>
              <span className="btn__shine" aria-hidden />
              {done ? '✓ خوش آمدی!' : busy ? <><span className="spinner" aria-hidden /> در حال بررسی…</> : mode === 'login' ? 'ورود به بازی' : 'ساخت حساب و ورود'}
            </button>
          </form>

          <div className="auth-perks" aria-hidden>
            <span>⚡ بازی زنده</span><span>⏱ تایمر نوبت</span><span>🛡 ورود امن</span>
          </div>
          <p className="auth-hint">رمز عبور شما در سرور به‌صورت متن ساده ذخیره نمی‌شود.</p>
        </section>
      </div>
    </main>
  );
}
