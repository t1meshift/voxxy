import { serveStt, type WorkerScope } from "../serve.js";
import { createAdapter } from "./dummy.impl.js";

serveStt(createAdapter, self as unknown as WorkerScope);
