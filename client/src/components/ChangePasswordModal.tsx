import { useState } from 'react';
import { api, session } from '../api/client';
import { useAuth } from '../store/auth';
import { Button, Field, Input, Modal, useFeedback } from './ui';

/** Self-service password change for any signed-in user (super admin, owner, any staff role). */
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const fb = useFeedback();
  const { user } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== next;
  const close = () => {
    setCur('');
    setNext('');
    setConfirm('');
    onClose();
  };
  const change = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/auth/change-password', { currentPassword: cur, newPassword: next });
      session.set(r.accessToken);
      fb.ok('Password changed — your other sessions were signed out');
      close();
    } catch (e) {
      fb.fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Change password"
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={change} loading={busy} disabled={!cur || next.length < 10 || next !== confirm}>Change password</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (cur && next.length >= 10 && next === confirm) change(); }}>
        <p className="text-sm text-stone-600">{user?.name} · {user?.email}</p>
        <Field label="Current password"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="At least 10 characters"><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Confirm new password" error={mismatch ? 'Passwords do not match' : undefined}><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
