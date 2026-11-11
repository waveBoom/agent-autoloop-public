import { World } from "./world.ts";
export function enumerate() {
  let paths = 0;
  let transitions = 0;
  const visit = (order: number[], left: number[]) => {
    if (left.length) {
      for (const n of left)
        visit(
          [...order, n],
          left.filter((x) => x !== n),
        );
      return;
    }
    const world = new World();
    const jobs = new Map<number, number>();
    world.call("createCard", {
      key: "question",
      kind: "ask",
      title: "选一个",
      text: "内容",
      options: ["甲", "乙"],
      rule: "one",
      lane: "#1",
      grp: "shared",
      source: "app",
    });
    for (const n of order) {
      if (n < 2) world.call("ingest", "app", { id: String(n), type: n ? "two" : "one", subject: `#${n + 1}` });
      else if (n < 4) {
        const job = world.call("claimNext", n === 2 ? "w1" : "w2", `c${n}`);
        if (job) jobs.set(n - 2, job.run);
      } else if (n < 6) {
        const id = jobs.get(n - 4);
        if (id) world.finish(id);
        else world.call("tick");
      } else if (n === 6) world.call("answer", 1, { choice: 0 });
      else world.call("resolve", 1, "核实完成", "本人");
    }
    world.recover();
    transitions += world.transitions;
    world.view.close();
    paths++;
  };
  visit(
    [],
    Array.from({ length: 8 }, (_, i) => i),
  );
  return { paths, transitions, actions: 8, workers: 2, events: 2, cards: 1 };
}
if (import.meta.main) console.log(JSON.stringify(enumerate(), null, 2));
