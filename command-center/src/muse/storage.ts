import { useEffect, useState } from "react";

export function useLocal<T>(key: string, initial: T): [T, (next: T) => void, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setValue(JSON.parse(raw) as T);
    } catch {
      /* keep initial */
    }
    setReady(true);
  }, [key]);
  function set(next: T) {
    setValue(next);
    localStorage.setItem(key, JSON.stringify(next));
  }
  return [value, set, ready];
}
