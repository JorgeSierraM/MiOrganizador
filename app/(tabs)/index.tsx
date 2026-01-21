import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  TextInput,
  Modal,
  Dimensions,
  AppState,
  AppStateStatus,
  Alert,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LineChart } from "react-native-chart-kit";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";

type ISODate = `${number}-${string}-${string}`;
type Status = "done" | "missed" | null;

type Activity = {
  id: string;
  name: string;
};

type StatusByDate = Record<string, Record<ISODate, Exclude<Status, null> | null>>;

type PersistedState = {
  activities: Activity[];
  statusByDate: StatusByDate;
  lastClosedISO: ISODate | null;
};

const STORAGE_KEY = "mi_organizador_v1";
const APP_NAME = "MiOrganizador";

// -------- utilidades fecha ----------
const pad2 = (n: number): string => String(n).padStart(2, "0");

const toISODate = (d: Date): ISODate =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` as ISODate;

const parseISO = (iso: ISODate): Date => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
};

const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
};

const addDaysISO = (iso: ISODate, days: number): ISODate => toISODate(addDays(parseISO(iso), days));

const diffDays = (fromISO: ISODate, toISO: ISODate): number => {
  const a = parseISO(fromISO).getTime();
  const b = parseISO(toISO).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
};

const startOfWeekMonday = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const daysInMonth = (year: number, monthIndex0: number): number => new Date(year, monthIndex0 + 1, 0).getDate();

const weekdayLabels = ["L", "M", "M", "J", "V", "S", "D"] as const;

// Fecha bonita (es-CO)
const formatPrettyDate = (iso: ISODate): string => {
  const d = parseISO(iso);
  return new Intl.DateTimeFormat("es-CO", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(d);
};

// -------- persistencia ----------
async function loadState(): Promise<PersistedState | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as PersistedState) : null;
}

async function saveState(state: PersistedState): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// -------- cierre automático ----------
function closeMissingDays(params: {
  activities: Activity[];
  statusByDate: StatusByDate;
  lastClosedISO: ISODate | null;
  todayISO: ISODate;
}): { statusByDate: StatusByDate; lastClosedISO: ISODate } {
  const { activities, statusByDate, lastClosedISO, todayISO } = params;

  if (!lastClosedISO) return { statusByDate, lastClosedISO: todayISO };

  const days = diffDays(lastClosedISO, todayISO);
  if (days <= 0) return { statusByDate, lastClosedISO };

  let next: StatusByDate = { ...statusByDate };

  for (let i = 1; i <= days; i++) {
    const dayISO = addDaysISO(lastClosedISO, i);
    if (dayISO === todayISO) break;

    for (const a of activities) {
      const current: Status = next?.[a.id]?.[dayISO] ?? null;
      if (current === null) {
        next = {
          ...next,
          [a.id]: { ...(next[a.id] || {}), [dayISO]: "missed" },
        };
      }
    }
  }

  return { statusByDate: next, lastClosedISO: todayISO };
}

// -------- serie mensual (# done por día) ----------
function buildMonthlySeries(params: {
  year: number;
  monthIndex0: number;
  statusByDate: StatusByDate;
  todayISO: ISODate;
}): { labels: string[]; data: Array<number | null> } {
  const { year, monthIndex0, statusByDate, todayISO } = params;

  const totalDays = daysInMonth(year, monthIndex0);
  const today = parseISO(todayISO);

  const labels = Array.from({ length: totalDays }, (_, i) => String(i + 1));
  const activityIds = Object.keys(statusByDate);

  const data = Array.from({ length: totalDays }, (_, i): number | null => {
    const d = new Date(year, monthIndex0, i + 1);
    d.setHours(0, 0, 0, 0);
    const iso = toISODate(d);

    if (d > today) return null;

    let count = 0;
    for (const id of activityIds) {
      if (statusByDate?.[id]?.[iso] === "done") count += 1;
    }
    return count;
  });

  return { labels, data };
}

const uid = (): string => Math.random().toString(36).slice(2, 10);

export default function Index(): React.ReactElement {
  const insets = useSafeAreaInsets();

  const [todayISO, setTodayISO] = useState<ISODate>(toISODate(new Date()));
  const [activities, setActivities] = useState<Activity[]>([]);
  const [statusByDate, setStatusByDate] = useState<StatusByDate>({});
  const [lastClosedISO, setLastClosedISO] = useState<ISODate | null>(null);

  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>("");

  const appState = useRef<AppStateStatus>(AppState.currentState);

  const weekStart = useMemo(() => startOfWeekMonday(parseISO(todayISO)), [todayISO]);
  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  // -------- NUEVO: recargar al enfocar (para ver import inmediato)
  const reloadFromStorage = React.useCallback(async () => {
    const saved = await loadState();
    if (!saved) return;

    setActivities(saved.activities || []);
    setStatusByDate(saved.statusByDate || {});
    setLastClosedISO(saved.lastClosedISO ?? null);

    const fixed = closeMissingDays({
      activities: saved.activities || [],
      statusByDate: saved.statusByDate || {},
      lastClosedISO: saved.lastClosedISO ?? null,
      todayISO,
    });

    setStatusByDate(fixed.statusByDate);
    setLastClosedISO(fixed.lastClosedISO);

    await saveState({
      activities: saved.activities || [],
      statusByDate: fixed.statusByDate,
      lastClosedISO: fixed.lastClosedISO,
    });
  }, [todayISO]);

  useFocusEffect(
    React.useCallback(() => {
      reloadFromStorage();
      return () => {};
    }, [reloadFromStorage])
  );
  // -------- FIN NUEVO

  // cargar inicial (primera vez)
  useEffect(() => {
    (async () => {
      const saved = await loadState();

      if (!saved) {
        const init: PersistedState = { activities: [], statusByDate: {}, lastClosedISO: todayISO };
        await saveState(init);
        setActivities([]);
        setStatusByDate({});
        setLastClosedISO(todayISO);
        return;
      }

      setActivities(saved.activities || []);
      setStatusByDate(saved.statusByDate || {});
      setLastClosedISO(saved.lastClosedISO ?? null);

      const fixed = closeMissingDays({
        activities: saved.activities || [],
        statusByDate: saved.statusByDate || {},
        lastClosedISO: saved.lastClosedISO ?? null,
        todayISO,
      });

      setStatusByDate(fixed.statusByDate);
      setLastClosedISO(fixed.lastClosedISO);

      await saveState({
        activities: saved.activities || [],
        statusByDate: fixed.statusByDate,
        lastClosedISO: fixed.lastClosedISO,
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // guardar
  useEffect(() => {
    (async () => {
      await saveState({ activities, statusByDate, lastClosedISO });
    })();
  }, [activities, statusByDate, lastClosedISO]);

  // foreground: actualiza hoy + cierre
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (nextState) => {
      const prev = appState.current;
      appState.current = nextState;

      if (prev.match(/inactive|background/) && nextState === "active") {
        const newToday = toISODate(new Date());
        setTodayISO(newToday);

        const fixed = closeMissingDays({ activities, statusByDate, lastClosedISO, todayISO: newToday });
        setStatusByDate(fixed.statusByDate);
        setLastClosedISO(fixed.lastClosedISO);

        await saveState({ activities, statusByDate: fixed.statusByDate, lastClosedISO: fixed.lastClosedISO });
      }
    });

    return () => sub.remove();
  }, [activities, statusByDate, lastClosedISO]);

  const getStatus = (activityId: string, iso: ISODate): Status => statusByDate?.[activityId]?.[iso] ?? null;

  const cycleTodayStatus = (current: Status): Status => (current === "done" ? null : "done");

  const onPressCell = (activityId: string, iso: ISODate): void => {
    if (iso !== todayISO) return;

    setStatusByDate((prev) => {
      const current: Status = prev?.[activityId]?.[iso] ?? null;
      const nextVal = cycleTodayStatus(current);

      return {
        ...prev,
        [activityId]: {
          ...(prev[activityId] || {}),
          [iso]: nextVal,
        },
      };
    });
  };

  const cellStyleByStatus = (status: Status): { backgroundColor: string } => {
    if (status === "done") return { backgroundColor: "#2ecc71" };
    if (status === "missed") return { backgroundColor: "#e74c3c" };
    return { backgroundColor: "#ecf0f1" };
  };

  const addActivity = (): void => {
    const name = newName.trim();
    if (!name) return;

    setActivities((prev) => [{ id: uid(), name }, ...prev]);
    setNewName("");
    setAddOpen(false);
  };

  const deleteActivity = (activityId: string): void => {
    Alert.alert(
      "Eliminar actividad",
      "¿Seguro que deseas eliminar esta actividad? Su historial mensual se conservará.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Eliminar",
          style: "destructive",
          onPress: () => setActivities((prev) => prev.filter((a) => a.id !== activityId)),
        },
      ]
    );
  };

  // --------- gráfica ----------
  const screenW = Dimensions.get("window").width;
  const today = parseISO(todayISO);
  const year = today.getFullYear();
  const monthIndex0 = today.getMonth();

  const { labels, data } = useMemo(
    () => buildMonthlySeries({ year, monthIndex0, statusByDate, todayISO }),
    [year, monthIndex0, statusByDate, todayISO]
  );

  const sparseLabels = useMemo(() => labels.map((l) => (Number(l) % 5 === 0 ? l : "")), [labels]);
  const chartValues: number[] = useMemo(() => data.map((v) => (v == null ? 0 : v)), [data]);

  const maxY = useMemo(() => {
    const m = Math.max(0, ...chartValues);
    return Math.max(4, m);
  }, [chartValues]);

  return (
    <SafeAreaView
      style={[
        styles.safe,
        {
          paddingTop: Math.max(insets.top, 10),
          paddingBottom: Math.max(insets.bottom, 10),
          paddingLeft: Math.max(insets.left, 14),
          paddingRight: Math.max(insets.right, 14),
        },
      ]}
      edges={["top", "bottom", "left", "right"]}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.appTitle}>{APP_NAME}</Text>

          <View style={styles.datePill}>
            <Text style={styles.datePillText}>{formatPrettyDate(todayISO)}</Text>
          </View>
        </View>

        <Pressable onPress={() => setAddOpen(true)} style={styles.addBtn}>
          <Text style={styles.addBtnText}>Agregar</Text>
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.grid}>
          <View style={styles.headerRow}>
            <View style={styles.activityHeaderCell}>
              <Text style={styles.headerText}>Actividad</Text>
            </View>

            {weekDates.map((d, idx) => {
              const iso = toISODate(d);
              const isToday = iso === todayISO;

              return (
                <View key={iso} style={[styles.dayHeaderCell, isToday && styles.todayOutline]}>
                  <Text style={styles.headerText}>{weekdayLabels[idx]}</Text>
                  <Text style={styles.headerSubText}>{d.getDate()}</Text>
                </View>
              );
            })}
          </View>

          {activities.length === 0 ? (
            <View style={{ padding: 12 }}>
              <Text style={{ color: "#7f8c8d" }}>No hay actividades. Presiona “Agregar”.</Text>
            </View>
          ) : (
            activities.map((a) => (
              <View key={a.id} style={styles.row}>
                <View style={styles.activityCell}>
                  <View style={styles.activityCellRow}>
                    <Text style={styles.activityText} numberOfLines={1}>
                      {a.name}
                    </Text>
                    <Pressable onPress={() => deleteActivity(a.id)} style={styles.deleteBtn}>
                      <Text style={styles.deleteText}>X</Text>
                    </Pressable>
                  </View>
                </View>

                {weekDates.map((d) => {
                  const iso = toISODate(d);
                  const status = getStatus(a.id, iso);
                  const isToday = iso === todayISO;
                  const disabled = !isToday;

                  return (
                    <Pressable
                      key={`${a.id}-${iso}`}
                      onPress={() => onPressCell(a.id, iso)}
                      disabled={disabled}
                      style={({ pressed }) => [
                        styles.cell,
                        cellStyleByStatus(status),
                        disabled && styles.disabledCell,
                        pressed && !disabled && styles.pressed,
                        isToday && styles.todayOutline,
                      ]}
                    >
                      <Text style={styles.cellText}>{status === "done" ? "✓" : status === "missed" ? "✗" : ""}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ))
          )}
        </View>
      </ScrollView>

      <View style={{ marginTop: 14 }}>
        <Text style={styles.chartTitle}>Actividades cumplidas (mes)</Text>

        <LineChart
          data={{
            labels: sparseLabels,
            datasets: [
              {
                data: chartValues,
                color: (opacity = 1) => `rgba(17, 24, 39, ${opacity})`,
                strokeWidth: 3,
              },
            ],
            legend: ["Cumplidas"],
          }}
          width={Math.min(screenW - 28, 900)}
          height={210}
          bezier
          fromZero
          fromNumber={maxY}
          segments={maxY}
          formatYLabel={(y) => String(Math.round(Number(y)))}
          yAxisInterval={1}
          withHorizontalLabels={true}
          withVerticalLabels={true}
          yLabelsOffset={8}
          xLabelsOffset={-2}
          withDots
          withInnerLines={false}
          withOuterLines={false}
          withShadow={false}
          chartConfig={{
            backgroundGradientFrom: "#ffffff",
            backgroundGradientTo: "#ffffff",
            decimalPlaces: 0,
            color: (opacity = 1) => `rgba(17, 24, 39, ${opacity})`,
            labelColor: (opacity = 1) => `rgba(107, 114, 128, ${opacity})`,
            propsForDots: { r: "4", strokeWidth: "2", stroke: "#ffffff" },
            propsForLabels: { fontSize: 10 },
            fillShadowGradientFrom: "rgba(17, 24, 39, 0.18)",
            fillShadowGradientTo: "rgba(17, 24, 39, 0.00)",
            fillShadowGradientFromOpacity: 1,
            fillShadowGradientToOpacity: 1,
          }}
          style={{
            marginVertical: 6,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: "#e5e7eb",
            paddingRight: 28,
            paddingLeft: 8,
          }}
        />

        <Text style={styles.hint}>
          Solo puedes marcar hoy (✓). Al cambiar el día, lo no marcado pasa a rojo automáticamente.
        </Text>
      </View>

      <Modal visible={addOpen} transparent animationType="fade" onRequestClose={() => setAddOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Nueva actividad</Text>

            <TextInput value={newName} onChangeText={setNewName} placeholder="Ej: Leer 20 min" style={styles.modalInput} />

            <View style={styles.modalRow}>
              <Pressable onPress={() => setAddOpen(false)} style={[styles.modalBtn, styles.modalCancel]}>
                <Text style={styles.modalBtnText}>Cancelar</Text>
              </Pressable>
              <Pressable onPress={addActivity} style={[styles.modalBtn, styles.modalOk]}>
                <Text style={styles.modalBtnText}>Guardar</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "white" },

  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10,
  },

  appTitle: {
    fontSize: 22,
    fontWeight: "900",
    color: "#111827",
    letterSpacing: 0.2,
    textShadowColor: "rgba(0,0,0,0.10)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },

  datePill: {
    alignSelf: "flex-start",
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#f3f4f6",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  datePillText: { color: "#374151", fontWeight: "600", textTransform: "capitalize" },

  addBtn: { backgroundColor: "#111827", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12 },
  addBtnText: { color: "#fff", fontWeight: "800" },

  grid: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 12, overflow: "hidden" },

  headerRow: { flexDirection: "row" },
  activityHeaderCell: {
    width: 140,
    padding: 8,
    borderRightWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
    justifyContent: "center",
  },
  dayHeaderCell: {
    width: 42,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
    alignItems: "center",
    justifyContent: "center",
  },
  headerText: { fontWeight: "800", fontSize: 12, color: "#111827" },
  headerSubText: { fontSize: 11, color: "#6b7280" },

  row: { flexDirection: "row" },

  activityCell: {
    width: 140,
    padding: 8,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderColor: "#e5e7eb",
    justifyContent: "center",
    backgroundColor: "white",
  },
  activityCellRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  activityText: { fontSize: 13, flex: 1, color: "#111827" },

  deleteBtn: { backgroundColor: "#ef4444", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  deleteText: { color: "white", fontWeight: "900", fontSize: 11 },

  cell: {
    width: 42,
    height: 36,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderColor: "#e5e7eb",
    alignItems: "center",
    justifyContent: "center",
  },
  cellText: { fontSize: 16, fontWeight: "900", color: "#111827" },

  disabledCell: { opacity: 0.45 },
  pressed: { transform: [{ scale: 0.98 }] },
  todayOutline: { borderColor: "#111827", borderWidth: 2 },

  chartTitle: { fontSize: 16, fontWeight: "800", marginBottom: 8, color: "#111827" },
  hint: { marginTop: 8, color: "#6b7280", fontSize: 12 },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 18 },
  modalCard: { backgroundColor: "white", borderRadius: 14, padding: 14 },
  modalTitle: { fontSize: 16, fontWeight: "800", marginBottom: 10, color: "#111827" },
  modalInput: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 12, padding: 10 },
  modalRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 12 },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
  modalCancel: { backgroundColor: "#9ca3af" },
  modalOk: { backgroundColor: "#111827" },
  modalBtnText: { color: "white", fontWeight: "800" },
});
