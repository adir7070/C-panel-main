/**
 * MyManagerCard — show the client WHO is handling their account.
 * Drop-in React Native component for the mobile home screen / settings.
 *
 *   GET /api/public/my-manager?phone=05XXXXXXXX
 *     → { manager: { id, name, avatarUrl, bio, phone, rating,
 *                    ratingCount, assignedAt },
 *         myRating: { stars, comment, updatedAt } | null }
 *
 * Renders an avatar + name + ★ rating, with quick-action buttons to
 * call/WhatsApp the manager directly. If the client hasn't picked a
 * manager yet, surfaces a "בחר/י את המנהל שלך" CTA that opens the
 * ChooseManagerScreen.
 *
 * Zero external UI deps. Linking is from `react-native` core.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  Alert,
} from "react-native";

const API_BASE = "https://api.iconiqmedia.co.il";

/* ── Types ─────────────────────────────────────────────────────────── */

export interface MyManager {
  id:           string;
  name:         string | null;
  avatarUrl:    string | null;
  bio:          string | null;
  phone:        string | null;
  rating:       number | null;
  ratingCount:  number;
  assignedAt:   string | null;
}

export interface MyRating {
  stars:     number;
  comment:   string | null;
  updatedAt: string | null;
}

interface Props {
  /** Client's phone. Required. */
  phone: string;
  /** Called when the client has no manager yet — typically opens the
   *  ChooseManagerScreen modal. */
  onChooseManager?: () => void;
  /** Called when the client taps the "Rate" button. Typically opens a
   *  small star-picker modal that uses rateMyManager(). */
  onRateManager?: (manager: MyManager, existing: MyRating | null) => void;
}

/* ── Component ─────────────────────────────────────────────────────── */

export function MyManagerCard({ phone, onChooseManager, onRateManager }: Props) {
  const [manager, setManager]   = useState<MyManager | null>(null);
  const [myRating, setMyRating] = useState<MyRating | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/public/my-manager?phone=${encodeURIComponent(phone)}`, {
        headers: { Accept: "application/json" },
      });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      const data = await r.json();
      setManager(data.manager || null);
      setMyRating(data.myRating || null);
    } catch (e: any) {
      setError(e?.message || "שגיאה");
    } finally {
      setLoading(false);
    }
  }, [phone]);

  useEffect(() => { load(); }, [load]);

  /* ── Render ──────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <View style={[styles.card, styles.centered]}>
        <ActivityIndicator size="small" color={C.brand} />
      </View>
    );
  }

  if (error) {
    return (
      <TouchableOpacity style={[styles.card, styles.centered]} onPress={load}>
        <Text style={styles.errorText}>שגיאה בטעינה · לחץ לנסות שוב</Text>
      </TouchableOpacity>
    );
  }

  /* No manager yet — show the CTA. */
  if (!manager) {
    return (
      <TouchableOpacity
        style={[styles.card, styles.emptyCard]}
        onPress={onChooseManager}
        activeOpacity={0.92}
      >
        <View style={styles.emptyAvatar}>
          <Text style={styles.emptyAvatarText}>?</Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.emptyTitle}>בחר/י את המנהל שלך</Text>
          <Text style={styles.emptySubtitle}>
            כדי שנוכל להתחיל לעבוד יחד, בחר/י איזה מנהל ילווה אותך
          </Text>
        </View>
        <Text style={styles.arrow}>‹</Text>
      </TouchableOpacity>
    );
  }

  const callable = manager.phone && manager.phone.length >= 6;
  const onCall = () => {
    if (!callable) return;
    Linking.openURL(`tel:${manager.phone}`).catch(() => Alert.alert("שגיאה", "לא ניתן לפתוח חייגן"));
  };
  const onWhatsApp = () => {
    if (!callable) return;
    /* WhatsApp deep link — works with both 0XX and 972XX formats. */
    const digits = (manager.phone || "").replace(/\D/g, "");
    const intl   = digits.startsWith("0") ? `972${digits.slice(1)}` : digits;
    Linking.openURL(`whatsapp://send?phone=${intl}`).catch(() =>
      Linking.openURL(`https://wa.me/${intl}`).catch(() =>
        Alert.alert("שגיאה", "WhatsApp לא מותקן"),
      ),
    );
  };

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>המנהל שלך</Text>

      <View style={styles.row}>
        <View style={styles.avatarWrap}>
          {manager.avatarUrl
            ? <Image source={{ uri: manager.avatarUrl }} style={styles.avatarImg} />
            : <Text style={styles.avatarInitial}>{(manager.name || "?").charAt(0).toUpperCase()}</Text>}
        </View>

        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{manager.name || "המנהל"}</Text>
          <Stars rating={manager.rating} count={manager.ratingCount} />
          {manager.bio ? <Text style={styles.bio} numberOfLines={2}>{manager.bio}</Text> : null}
        </View>
      </View>

      <View style={styles.actions}>
        <ActionBtn
          icon="📞"
          label="חייג"
          disabled={!callable}
          onPress={onCall}
        />
        <ActionBtn
          icon="💬"
          label="WhatsApp"
          disabled={!callable}
          onPress={onWhatsApp}
          primary
        />
        {onRateManager && (
          <ActionBtn
            icon="★"
            label={myRating ? `דרוג ${myRating.stars}/5` : "דרג"}
            onPress={() => onRateManager(manager, myRating)}
          />
        )}
      </View>
    </View>
  );
}

/* ── Pieces ────────────────────────────────────────────────────────── */

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

function ActionBtn({
  icon, label, onPress, disabled, primary,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.actionBtn,
        primary && styles.actionBtnPrimary,
        disabled && styles.actionBtnDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
    >
      <Text style={[styles.actionIcon, primary && styles.actionIconPrimary]}>{icon}</Text>
      <Text style={[styles.actionLabel, primary && styles.actionLabelPrimary]}>{label}</Text>
    </TouchableOpacity>
  );
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
  green:  "#10B981",
  gold:   "#F59E0B",
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.paper,
    borderColor: C.rule,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginVertical: 8,
    marginHorizontal: 16,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  centered: { alignItems: "center", justifyContent: "center", minHeight: 92 },
  errorText: { color: "#B91C1C", fontSize: 13 },

  eyebrow: {
    fontSize: 11, fontWeight: "700", letterSpacing: 0.5,
    color: C.brand, textTransform: "uppercase", marginBottom: 12,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 14 },

  avatarWrap: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: "#EEF2FF",
    alignItems: "center", justifyContent: "center",
    overflow: "hidden",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInitial: { fontSize: 24, fontWeight: "800", color: C.brand },

  info: { flex: 1, minWidth: 0 },
  name: { fontSize: 17, fontWeight: "800", color: C.ink },
  bio: { fontSize: 12, color: C.ink3, lineHeight: 18, marginTop: 4 },

  starsRow: { flexDirection: "row", alignItems: "center", gap: 2, marginTop: 4 },
  starFull: { color: C.gold, fontSize: 13 },
  starEmpty: { color: C.rule, fontSize: 13 },
  ratingNum: { color: C.ink2, fontSize: 12, fontWeight: "700", marginStart: 4 },
  noRating: { color: C.ink3, fontSize: 11, marginTop: 4 },
  countPill: {
    color: C.ink3, fontSize: 10, fontWeight: "600",
    backgroundColor: C.bg, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999,
    overflow: "hidden",
    marginStart: 4,
  },

  actions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: C.bg,
    borderColor: C.rule,
    borderWidth: 1,
  },
  actionBtnPrimary: {
    backgroundColor: C.green,
    borderColor: C.green,
  },
  actionBtnDisabled: { opacity: 0.4 },
  actionIcon: { fontSize: 14 },
  actionIconPrimary: { color: "#fff" },
  actionLabel: { fontSize: 12, fontWeight: "700", color: C.ink },
  actionLabelPrimary: { color: "#fff" },

  /* Empty state */
  emptyCard: {
    flexDirection: "row", alignItems: "center", gap: 14,
    borderColor: C.brand, borderStyle: "dashed",
  },
  emptyAvatar: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: "#EEF2FF",
    alignItems: "center", justifyContent: "center",
  },
  emptyAvatarText: { fontSize: 28, color: C.brand, fontWeight: "800" },
  emptyTitle: { fontSize: 15, fontWeight: "800", color: C.ink },
  emptySubtitle: { fontSize: 12, color: C.ink2, marginTop: 2, lineHeight: 18 },
  arrow: { fontSize: 28, color: C.ink3 },
});
