import { serveTts, type WorkerScope } from "../serve.js";
import { createAdapter } from "./paradee.impl.js";

serveTts(createAdapter, self as unknown as WorkerScope);
