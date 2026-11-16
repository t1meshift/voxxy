import { serveTts, type WorkerScope } from "../serve.js";
import { createAdapter } from "./dummy.impl.js";

serveTts(createAdapter, self as unknown as WorkerScope);
