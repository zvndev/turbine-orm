import { QueryInterface } from 'turbine-orm';
import consumer from './runtime.cjs';
console.log(JSON.stringify(consumer.run(QueryInterface)));
