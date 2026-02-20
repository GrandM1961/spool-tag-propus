const DryingProfiles = {
  data: {
    'PLA':     { temp: 45, time: 4,  maxTemp: 50,  humidity: 'Mittel',  icon: '🟢', notes: 'Nicht über 50°C — PLA verformt sich leicht' },
    'PLA+':    { temp: 50, time: 4,  maxTemp: 55,  humidity: 'Mittel',  icon: '🟢', notes: '' },
    'PLA-CF':  { temp: 55, time: 6,  maxTemp: 60,  humidity: 'Mittel',  icon: '🟢', notes: 'CF-Varianten etwas wärmer trocknen' },
    'Silk PLA':{ temp: 45, time: 4,  maxTemp: 50,  humidity: 'Mittel',  icon: '🟢', notes: 'Vorsichtig trocknen — Seidenglanz empfindlich' },
    'PETG':    { temp: 65, time: 4,  maxTemp: 70,  humidity: 'Mittel',  icon: '🟡', notes: '' },
    'PETG-CF': { temp: 65, time: 6,  maxTemp: 70,  humidity: 'Mittel',  icon: '🟡', notes: '' },
    'ABS':     { temp: 80, time: 4,  maxTemp: 85,  humidity: 'Niedrig', icon: '🟡', notes: 'ABS nimmt weniger Feuchtigkeit auf als PETG' },
    'ASA':     { temp: 80, time: 4,  maxTemp: 85,  humidity: 'Niedrig', icon: '🟡', notes: 'Ähnlich wie ABS' },
    'TPU':     { temp: 55, time: 8,  maxTemp: 60,  humidity: 'Hoch',    icon: '🟠', notes: 'Braucht längere Trocknungszeit — sehr saugfähig' },
    'PA':      { temp: 70, time: 12, maxTemp: 80,  humidity: 'Sehr hoch', icon: '🔴', notes: 'Nylon ist extrem feuchtigkeitsempfindlich — am besten trocken lagern' },
    'PA6':     { temp: 70, time: 12, maxTemp: 80,  humidity: 'Sehr hoch', icon: '🔴', notes: '' },
    'PA12':    { temp: 70, time: 12, maxTemp: 80,  humidity: 'Sehr hoch', icon: '🔴', notes: '' },
    'PA-CF':   { temp: 70, time: 12, maxTemp: 80,  humidity: 'Sehr hoch', icon: '🔴', notes: 'Nylon-Basis — unbedingt trocken halten' },
    'PC':      { temp: 80, time: 8,  maxTemp: 120, humidity: 'Hoch',    icon: '🟠', notes: 'Hohe Trocknungstemperatur möglich' },
    'PVA':     { temp: 45, time: 4,  maxTemp: 50,  humidity: 'Extrem',  icon: '🔴', notes: 'Wasserlöslich! Sofort in Trockenbox lagern' },
    'HIPS':    { temp: 65, time: 4,  maxTemp: 70,  humidity: 'Mittel',  icon: '🟡', notes: '' },
    'PCTG':    { temp: 65, time: 4,  maxTemp: 70,  humidity: 'Mittel',  icon: '🟡', notes: '' },
    'PEEK':    { temp: 120, time: 6, maxTemp: 150, humidity: 'Mittel',  icon: '🟡', notes: 'Industriefilament — Trockner muss hohe Temps unterstützen' },
    'PEI':     { temp: 100, time: 6, maxTemp: 120, humidity: 'Mittel',  icon: '🟡', notes: '' },
    'BVOH':    { temp: 45, time: 4,  maxTemp: 50,  humidity: 'Extrem',  icon: '🔴', notes: 'Wasserlöslich — sofort versiegeln' },
  },

  getProfile(material) {
    const key = (material || '').toUpperCase().trim();
    if (this.data[key]) return { material: key, ...this.data[key] };
    for (const [k, v] of Object.entries(this.data)) {
      if (key.includes(k) || k.includes(key)) return { material: k, ...v };
    }
    return null;
  },

  getAllSorted() {
    const order = { '🔴': 0, '🟠': 1, '🟡': 2, '🟢': 3 };
    return Object.entries(this.data)
      .map(([k, v]) => ({ material: k, ...v }))
      .sort((a, b) => (order[a.icon] ?? 9) - (order[b.icon] ?? 9) || a.material.localeCompare(b.material));
  }
};
