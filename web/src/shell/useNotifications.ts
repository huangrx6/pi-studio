import { useCallback, useEffect, useState } from 'react';
import { errorText } from '../shared/error-text';
import {
  mergeNotification,
  notificationTitle,
} from './notification-state';
import type {
  AppNotification,
  AppNotificationAction,
  NotificationTone,
} from './NotificationCenter';

export function useNotifications() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  const pushNotification = useCallback((
    message: string,
    tone: NotificationTone = 'info',
    title?: string,
    sessionId?: string,
    action?: AppNotificationAction,
  ) => {
    const createdAt = Date.now();
    setNotifications((current) => mergeNotification(current, {
      id: crypto.randomUUID(),
      title: title || notificationTitle(tone),
      message: errorText(message),
      tone,
      createdAt,
      sessionId,
      action,
      read: false,
    }));
  }, []);

  useEffect(() => {
    const handleNotice = (event: Event) => {
      const detail = (event as CustomEvent<{
        message?: string;
        title?: string;
        tone?: NotificationTone;
        sessionId?: string;
      }>).detail;
      if (!detail?.message) return;
      pushNotification(detail.message, detail.tone, detail.title, detail.sessionId);
    };
    window.addEventListener('pi-studio:notify', handleNotice);
    return () => window.removeEventListener('pi-studio:notify', handleNotice);
  }, [pushNotification]);

  function markAllRead() {
    setNotifications((current) => current.map((item) => ({ ...item, read: true })));
  }

  function clearNotifications() {
    setNotifications([]);
  }

  return {
    notifications,
    setNotifications,
    pushNotification,
    markAllRead,
    clearNotifications,
  };
}
