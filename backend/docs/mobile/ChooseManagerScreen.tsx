/**
 * ChooseManagerScreen — drop-in React Native (Expo) screen for the
 * mobile onboarding flow. Renders the list of managers and lets the
 * client pick one. Hits the public endpoints on iconiq-server:
 *
 *   GET  /api/public/managers
 *   POST /api/public/managers/:id/choose  { phone }
 *   POST /api/public/managers/:id/rate    { phone, stars, comment? }
 *
 * All three endpoints are no-auth — they're designed to be called
 * pre-onboarding, before the client has a session token.
 *
 * Drop into the mobile app, point API_BASE at your server, navigate to
 * this screen on first launch (or "switch manager" later). The picked
 * manager triggers a real-time popup on that manager's C-panel via
 * the cpanel_client_chose_you socket event (already wired server-side).
 *
 * Styling uses inline StyleSheet so there are zero external deps
 * beyond react-native + (optionally) react-native-safe-area-context.
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
  I18nManager,
} from "react-native";

/* ── Config ────────────────────────────────────────────────────────── */

const API_BASE = "https://api.iconiqmedia.co.il";

/* Force RTL — must happen at app boot. If your app already does this
   elsewhere, you can drop these two lines. */
if (!I18nManager.isRTL) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

/* ── Types ─────────────────────────────────────────────────────────── */

export interface PublicManager {
  id:           string;
  name:         string | null;
  avatarUrl:    string | null;
  bio:          string | null;
  clientCount:  number;
  rating:       number | null;
  ratingCount:  number;
}

interface ChooseManagerScreenProps {
  /** Client phone — required. Used in the choose POST body. */
  phone: string;
  /** Called once the client successfully picks a manager.
   *  Pass the manager so the parent can navigate / mark onboarding done. */
  onChosen: (manager: { id: string; name: string }) => void;
}

/* ── Screen ────────────────────────────────────────────────────────── */

export function ChooseManagerScreen({ phone, onChosen }: ChooseManagerScreenProps) {
  const [managers, setManagers] = useState<PublicManager[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);  // managerId being submitted

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/public/managers`, {
        headers: { Accept: "application/json" },
      });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      const data = await r.json();
      setManagers(Array.isArray(data.managers) ? data.managers : []);
    } catch (e: any) {
      setError(e?.message || "שגיאה בטעינת המנהלים");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const choose = useCallback(async (m: PublicManager) => {
    if (!phone) {
      Alert.alert("שגיאה", "חסר מספר טלפון");
      return;
    }
    if (submitting) return;
    setSubmitting(m.id);
    try {
      const r = await fetch(`${API_BASE}/api/public/managers/${encodeURIComponent(m.id)}/choose`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ phone }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || j?.error || `Server error ${r.status}`);
      onChosen({ id: j.managerId || m.id, name: j.managerName || m.name || "המנהל" });
    } catch (e: any) {
      Alert.alert("שגיאה", e?.message || "שגיאה בשיוך המנהל");
      setSubmitting(null);
    }
  }, [phone, submitting, onChosen]);

  /* ── Render ──────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.loadingText}>טוען מנהלים…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={load} activeOpacity={0.85}>
          <Text style={styles.retryBtnText}>נסה שוב</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      data={managers}
      keyExtractor={(m) => m.id}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#4F46E5" />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.eyebrow}>
            <Text style={styles.eyebrowText}>ברוכים הבאים</Text>
          </View>
          <Text style={styles.title}>בחר/י את המנהל שלך</Text>
          <Text style={styles.lead}>
            המנהל שתבחר/י ילווה אותך אישית לאורך כל הדרך —
            בניית הקמפיינים, בחירת המוצרים והתאמת הפיתרון לעסק שלך.
          </Text>
        </View>
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>כרגע אין מנהלים זמינים — נסה שוב בעוד רגע</Text>
        </View>
      }
      renderItem={({ item }) => (
        <ManagerCard
          manager={item}
          busy={submitting !== null}
          selected={submitting === item.id}
          onPress={() => choose(item)}
        />
      )}
    />
  );
}

/* ── Manager card ──────────────────────────────────────────────────── */

function ManagerCard({
  manager, busy, selected, onPress,
}: {
  manager: PublicManager;
  busy: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.card, selected && styles.cardSelected, busy && !selected && styles.cardBusy]}
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.92}
    >
      <View style={styles.row}>
        <Avatar url={manager.avatarUrl} initial={initialOf(manager.name)} />
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{manager.name || "מנהל"}</Text>
          <View style={styles.metaRow}>
            <Stars rating={manager.rating} count={manager.ratingCount} />
            {manager.clientCount > 0 && (
              <Text style={styles.countPill}>
                {manager.clientCount} {manager.clientCount === 1 ? "לקוח" : "לקוחות"}
              </Text>
            )}
          </View>
          {manager.bio ? (
            <Text style={styles.bio} numberOfLines={2}>{manager.bio}</Text>
          ) : null}
        </View>
        {selected ? (
          <ActivityIndicator size="small" color="#4F46E5" />
        ) : (
          <Text style={styles.arrow}>‹</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

function Avatar({ url, initial }: { url: string | null; initial: string }) {
  return (
    <View style={styles.avatarWrap}>
      {url ? (
        <Image source={{ uri: url }} style={styles.avatarImg} />
      ) : (
        <Text style={styles.avatarInitial}>{initial}</Text>
      )}
    </View>
  );
}

function Stars({ rating, count }: { rating: number | null; count: number }) {
  if (!count || rating == null) {
    return <Text style={styles.noRating}>אין דירוגים עדיין</Text>;
  }
  const full = Math.round(rating);
  return (
    <View style={styles.starsRow}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Text key={i} style={i <= full ? styles.starFull : styles.starEmpty}>★</Text>
      ))}
      <Text style={styles.ratingNum}>{rating.toFixed(1)}</Text>
      <Text style={styles.countPill}>{count}</Text>
    </View>
  );
}

function initialOf(name: string | null) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

/* ── Styles ────────────────────────────────────────────────────────── */

const C = {
  ink:    "#0F172A",
  ink2:   "#475569",
  ink3:   "#94A3B8",
  paper:  "#ffffff",
  bg:     "#F7F8FB",
  rule:   "#E5E7EB",
  brand:  "#4F46E5",
  gold:   "#F59E0B",
};

const styles = StyleSheet.create({
  center: {
    flex: 1, alignItems: "center", justifyContent: "center",
    padding: 20, backgroundColor: C.bg,
  },
  loadingText: { marginTop: 12, color: C.ink2, fontSize: 14 },
  errorText: { color: "#B91C1C", fontSize: 14, textAlign: "center", marginBottom: 12 },
  retryBtn: {
    backgroundColor: "#B91C1C", paddingHorizontal: 22, paddingVertical: 10, borderRadius: 8,
  },
  retryBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  list: { padding: 16, backgroundColor: C.bg, flexGrow: 1 },
  header: { alignItems: "center", paddingVertical: 18, paddingHorizontal: 8 },
  eyebrow: {
    backgroundColor: C.brand, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999,
  },
  eyebrowText: { color: "#fff", fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  title: {
    marginTop: 12, fontSize: 24, fontWeight: "800",
    color: C.ink, textAlign: "center",
  },
  lead: {
    color: C.ink2, fontSize: 14, lineHeight: 22, textAlign: "center",
    marginTop: 6, paddingHorizontal: 8,
  },

  card: {
    backgroundColor: C.paper, borderColor: C.rule, borderWidth: 1, borderRadius: 16,
    padding: 14, marginBottom: 12,
    shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  cardSelected: {
    borderColor: C.brand, shadowOpacity: 0.18, shadowRadius: 20, elevation: 6,
  },
  cardBusy: { opacity: 0.55 },
  row: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatarWrap: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center",
    overflow: "hidden",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInitial: { fontSize: 24, fontWeight: "800", color: C.brand },
  info: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: "800", color: C.ink },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" },
  starsRow: { flexDirection: "row", alignItems: "center", gap: 2 },
  starFull: { color: C.gold, fontSize: 13 },
  starEmpty: { color: C.rule, fontSize: 13 },
  ratingNum: { color: C.ink2, fontSize: 12, fontWeight: "700", marginStart: 4 },
  noRating: { color: C.ink3, fontSize: 11 },
  countPill: {
    color: C.ink3, fontSize: 11, fontWeight: "600",
    backgroundColor: C.bg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999,
    overflow: "hidden",
  },
  bio: { fontSize: 12, color: C.ink3, lineHeight: 18, marginTop: 6 },
  arrow: { fontSize: 28, color: C.ink3, fontWeight: "300" },

  empty: { padding: 40, alignItems: "center" },
  emptyText: { color: C.ink3, fontSize: 14, textAlign: "center" },
});

/* ── Optional: rate-your-manager helper ────────────────────────────── */

/**
 * Call this after a meaningful interaction (e.g. campaign delivered).
 * Server rejects with 403 not_your_manager unless the phone is the
 * caller's assigned client.
 */
export async function rateMyManager(opts: {
  managerId: string;
  phone:     string;
  stars:     number;    // 1..5
  comment?:  string;
}): Promise<{ avg: number | null; ratingCount: number }> {
  const r = await fetch(`${API_BASE}/api/public/managers/${encodeURIComponent(opts.managerId)}/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ phone: opts.phone, stars: opts.stars, comment: opts.comment || undefined }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.message || j?.error || `Server error ${r.status}`);
  return { avg: j.avg ?? null, ratingCount: j.ratingCount ?? 0 };
}
