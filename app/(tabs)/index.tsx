import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  SafeAreaView,
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
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LineChart } from "react-native-chart-kit";

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
  const day = d.getDay(); // 0 dom, 1 lun...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const daysInMonth = (year: number, monthIndex0: number): number => new Date(year, monthIndex0 + 1, 0).getDate();

const weekdayLabels = ["L", "M", "M", "J", "V", "S", "D"] as const;

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
  activities: Activity[];
  statusByDate: StatusByDate;
  todayISO: ISODate;
}): { labels: string[]; data: Array<number | null> } {
  const { year, monthIndex0, activities, statusByDate, todayISO } = params;

  const totalDays = daysInMonth(year, monthIndex0);
  const today = parseISO(todayISO);

  const labels = Array.from({ length: totalDays }, (_, i) => String(i + 1));

  const data = Array.from({ length: totalDays }, (_, i): number | null => {
    const d = new Date(year, monthIndex0, i + 1);
    d.setHours(0, 0, 0, 0);
    const iso = toISODate(d);

    if (d > today) return null;

    let count = 0;
    for (const a of activities) {
      if (statusByDate?.[a.id]?.[iso] === "done") count += 1;
    }
    return count;
  });

  return { labels, data };
}

const uid = (): string => Math.random().toString(36).slice(2, 10);

export default function Index(): React.ReactElement {
  const [todayISO, setTodayISO] = useState<ISODate>(toISODate(new Date()));

  const [activities, setActivities] = useState<Activity[]>([
    { id: "a1", name: "Actividad 1" },
    { id: "a2", name: "Actividad 2" },
    { id: "a3", name: "Actividad 3" },
  ]);

  const [statusByDate, setStatusByDate] = useState<StatusByDate>({});
  const [lastClosedISO, setLastClosedISO] = useState<ISODate | null>(null);

  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>("");

  const appState = useRef<AppStateStatus>(AppState.currentState);

  const weekStart = useMemo(() => startOfWeekMonday(parseISO(todayISO)), [todayISO]);
  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  // cargar
  useEffect(() => {
    (async () => {
      const saved = await loadState();

      if (!saved) {
        const init: PersistedState = { activities, statusByDate: {}, lastClosedISO: todayISO };
        await saveState(init);
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

  // Hoy: vacío <-> done (rojo solo por cierre automático)
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

  const screenW = Dimensions.get("window").width;
  const today = parseISO(todayISO);
  const year = today.getFullYear();
  const monthIndex0 = today.getMonth();

  const { labels, data } = useMemo(
    () => buildMonthlySeries({ year, monthIndex0, activities, statusByDate, todayISO }),
    [year, monthIndex0, activities, statusByDate, todayISO]
  );

  const sparseLabels = useMemo(() => labels.map((l) => (Number(l) % 5 === 0 ? l : "")), [labels]);

  // Si TS se pone estricto con chart-kit, este cast evita errores de tipos.
  const chartData = useMemo(
    () =>
      ({
        labels: sparseLabels,
        datasets: [{ data: data as unknown as number[] }],
      }) as any,
    [sparseLabels, data]
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.topRow}>
        <Text style={styles.title}>Tablero semanal</Text>

        <Pressable onPress={() => setAddOpen(true)} style={styles.addBtn}>
          <Text style={styles.addBtnText}>Agregar actividad</Text>
        </Pressable>
      </View>

      <Text style={styles.subTitle}>Hoy: {todayISO}</Text>

      <ScrollView horizontal>
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

          {activities.map((a) => (
            <View key={a.id} style={styles.row}>
              <View style={styles.activityCell}>
                <Text style={styles.activityText}>{a.name}</Text>
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
          ))}
        </View>
      </ScrollView>

      <View style={{ marginTop: 16 }}>
        <Text style={styles.chartTitle}>Actividades cumplidas (mes)</Text>

        <LineChart
          data={chartData}
          width={Math.min(screenW - 32, 900)}
          height={220}
          withDots={true}
          withInnerLines={true}
          withOuterLines={false}
          fromZero={true}
          yAxisInterval={1}
          chartConfig={{
            backgroundGradientFrom: "#ffffff",
            backgroundGradientTo: "#ffffff",
            color: (opacity = 1) => `rgba(44, 62, 80, ${opacity})`,
            labelColor: (opacity = 1) => `rgba(127, 140, 141, ${opacity})`,
            decimalPlaces: 0,
            propsForDots: { r: "3" },
          }}
          style={{ borderWidth: 1, borderColor: "#bdc3c7" }}
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
  container: { flex: 1, padding: 16, backgroundColor: "white" },

  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  title: { fontSize: 18, fontWeight: "700" },
  subTitle: { marginTop: 6, color: "#7f8c8d" },

  addBtn: { backgroundColor: "#2c3e50", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  addBtnText: { color: "#fff", fontWeight: "700" },

  grid: { borderWidth: 1, borderColor: "#bdc3c7", marginTop: 12 },

  headerRow: { flexDirection: "row" },
  activityHeaderCell: {
    width: 160,
    padding: 10,
    borderRightWidth: 1,
    borderColor: "#bdc3c7",
    backgroundColor: "#f7f7f7",
    justifyContent: "center",
  },
  dayHeaderCell: {
    width: 56,
    paddingVertical: 8,
    borderRightWidth: 1,
    borderColor: "#bdc3c7",
    backgroundColor: "#f7f7f7",
    alignItems: "center",
    justifyContent: "center",
  },
  headerText: { fontWeight: "700" },
  headerSubText: { fontSize: 12, color: "#7f8c8d" },

  row: { flexDirection: "row" },
  activityCell: {
    width: 160,
    padding: 10,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderColor: "#bdc3c7",
    justifyContent: "center",
  },
  activityText: { fontSize: 14 },

  cell: {
    width: 56,
    height: 44,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderColor: "#bdc3c7",
    alignItems: "center",
    justifyContent: "center",
  },
  cellText: { fontSize: 18, fontWeight: "700" },

  disabledCell: { opacity: 0.45 },
  pressed: { transform: [{ scale: 0.98 }] },
  todayOutline: { borderColor: "#2c3e50", borderWidth: 2 },

  chartTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  hint: { marginTop: 8, color: "#7f8c8d" },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 18 },
  modalCard: { backgroundColor: "white", borderRadius: 14, padding: 14 },
  modalTitle: { fontSize: 16, fontWeight: "700", marginBottom: 10 },
  modalInput: { borderWidth: 1, borderColor: "#bdc3c7", borderRadius: 10, padding: 10 },
  modalRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 12 },
  modalBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  modalCancel: { backgroundColor: "#95a5a6" },
  modalOk: { backgroundColor: "#2c3e50" },
  modalBtnText: { color: "white", fontWeight: "700" },
});
