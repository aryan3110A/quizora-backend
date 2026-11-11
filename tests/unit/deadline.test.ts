import { describe, expect, it } from "vitest";
function deadline(start:Date,durationMinutes:number,end:Date){return new Date(Math.min(start.getTime()+durationMinutes*60_000,end.getTime()));}
describe("attempt deadline",()=>{
 it("uses the duration deadline when earlier",()=>{const start=new Date("2026-10-18T10:00:00Z");expect(deadline(start,30,new Date("2026-10-18T11:00:00Z")).toISOString()).toBe("2026-10-18T10:30:00.000Z");});
 it("caps the deadline at quiz closing",()=>{const start=new Date("2026-10-18T10:40:00Z");expect(deadline(start,30,new Date("2026-10-18T11:00:00Z")).toISOString()).toBe("2026-10-18T11:00:00.000Z");});
});
