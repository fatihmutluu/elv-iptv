/** D-Bus 1.0 message type bytes. */
export const DBUS_MSG_TYPE = Object.freeze({
  METHOD_CALL: 1,
  METHOD_RETURN: 2,
  ERROR: 3,
  SIGNAL: 4,
} as const);

const DBUS_HEADER_FIELD = {
  PATH: 1,
  INTERFACE: 2,
  MEMBER: 3,
  ERROR_NAME: 4,
  REPLY_SERIAL: 5,
  DESTINATION: 6,
  SENDER: 7,
  SIGNATURE: 8,
} as const;

const LITTLE_ENDIAN = 0x6c; // 'l'
const BIG_ENDIAN = 0x42; // 'B'
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_NESTING_DEPTH = 16;

/** Tagged D-Bus variant (`'v'`). */
export interface DbusVariant {
  readonly signature: string;
  readonly value: unknown;
}

/** Builds a tagged D-Bus variant value for marshalling. */
export function dbusVariant(signature: string, value: unknown): DbusVariant {
  return { signature, value };
}

/** Decoded or outgoing D-Bus 1.0 message. */
export interface DbusMessage {
  readonly type: number;
  readonly flags: number;
  readonly serial: number;
  readonly path?: string;
  readonly interface?: string;
  readonly member?: string;
  readonly errorName?: string;
  readonly replySerial?: number;
  readonly destination?: string;
  readonly sender?: string;
  readonly signature?: string;
  readonly body: readonly unknown[];
}

function alignUp(offset: number, alignment: number): number {
  const rem = offset % alignment;
  return rem === 0 ? offset : offset + (alignment - rem);
}

/** Splits a D-Bus type signature string into complete single-type tokens. */
export function splitCompleteTypes(signature: string, depth = 0): string[] {
  if (depth > MAX_NESTING_DEPTH) throw new Error('D-Bus signature nesting too deep');
  const out: string[] = [];
  let i = 0;
  while (i < signature.length) {
    const start = i;
    const ch = signature[i];
    if (ch === 'a') {
      i += 1;
      if (i >= signature.length) {
        throw new Error(`Incomplete array type in signature: ${signature}`);
      }
      const rest = splitCompleteTypes(signature.slice(i), depth + 1);
      const elem = rest[0];
      if (!elem) throw new Error(`Missing array element type in signature: ${signature}`);
      i += elem.length;
      out.push(signature.slice(start, i));
    } else if (ch === '(' || ch === '{') {
      const close = ch === '(' ? ')' : '}';
      let nest = 1;
      i += 1;
      while (i < signature.length && nest > 0) {
        if (signature[i] === ch) nest += 1;
        else if (signature[i] === close) nest -= 1;
        i += 1;
      }
      if (nest !== 0) throw new Error(`Unclosed container in D-Bus signature: ${signature}`);
      const inner = signature.slice(start + 1, i - 1);
      if (inner.length === 0) throw new Error(`Empty container in D-Bus signature: ${signature}`);
      splitCompleteTypes(inner, depth + 1);
      out.push(signature.slice(start, i));
    } else if (ch && 'ybnqiuxtdsogv'.includes(ch)) {
      i += 1;
      out.push(ch);
    } else {
      throw new Error(`Unsupported D-Bus type char '${ch ?? ''}' in signature: ${signature}`);
    }
  }
  return out;
}

function alignmentOf(type: string): number {
  switch (type[0]) {
    case 'y':
    case 'g':
    case 'v':
      return 1;
    case 'n':
    case 'q':
      return 2;
    case 'b':
    case 'i':
    case 'u':
    case 's':
    case 'o':
    case 'a':
      return 4;
    case 'x':
    case 't':
    case 'd':
    case '(':
    case '{':
      return 8;
    default:
      throw new Error(`Unknown D-Bus type: ${type}`);
  }
}

class DbusWriter {
  private buf: Buffer = Buffer.alloc(256);
  private pos = 0;

  private ensure(extra: number): void {
    const needed = this.pos + extra;
    if (needed <= this.buf.length) return;
    let nextLen = this.buf.length;
    while (nextLen < needed) nextLen *= 2;
    const grown = Buffer.alloc(nextLen);
    this.buf.copy(grown, 0, 0, this.pos);
    this.buf = grown;
  }

  align(n: number): void {
    const target = alignUp(this.pos, n);
    if (target > this.pos) {
      this.ensure(target - this.pos);
      this.buf.fill(0, this.pos, target);
      this.pos = target;
    }
  }

  writeByte(v: number): void {
    this.ensure(1);
    this.buf[this.pos] = v & 0xff;
    this.pos += 1;
  }

  writeInt16(v: number): void {
    this.align(2);
    this.ensure(2);
    this.buf.writeInt16LE((v << 16) >> 16, this.pos);
    this.pos += 2;
  }

  writeUInt16(v: number): void {
    this.align(2);
    this.ensure(2);
    this.buf.writeUInt16LE(v & 0xffff, this.pos);
    this.pos += 2;
  }

  writeUInt32(v: number): void {
    this.align(4);
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.pos);
    this.pos += 4;
  }

  writeInt32(v: number): void {
    this.align(4);
    this.ensure(4);
    this.buf.writeInt32LE(v | 0, this.pos);
    this.pos += 4;
  }

  writeInt64(v: bigint | number): void {
    this.align(8);
    this.ensure(8);
    const big = typeof v === 'bigint' ? v : BigInt(Math.trunc(v));
    this.buf.writeBigInt64LE(big, this.pos);
    this.pos += 8;
  }

  writeUInt64(v: bigint | number): void {
    this.align(8);
    this.ensure(8);
    const big = typeof v === 'bigint' ? v : BigInt(Math.max(0, Math.trunc(v)));
    this.buf.writeBigUInt64LE(big, this.pos);
    this.pos += 8;
  }

  writeDouble(v: number): void {
    this.align(8);
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.pos);
    this.pos += 8;
  }

  writeString(v: string): void {
    const bytes = Buffer.from(v, 'utf8');
    this.writeUInt32(bytes.length);
    this.ensure(bytes.length + 1);
    bytes.copy(this.buf, this.pos);
    this.pos += bytes.length;
    this.buf[this.pos] = 0;
    this.pos += 1;
  }

  writeSignature(sig: string): void {
    const bytes = Buffer.from(sig, 'ascii');
    if (bytes.length > 255) throw new Error('D-Bus signature exceeds 255 bytes');
    this.ensure(bytes.length + 2);
    this.buf[this.pos] = bytes.length;
    this.pos += 1;
    bytes.copy(this.buf, this.pos);
    this.pos += bytes.length;
    this.buf[this.pos] = 0;
    this.pos += 1;
  }

  writeValue(type: string, value: unknown): void {
    switch (type[0]) {
      case 'y':
        this.writeByte(Number(value));
        return;
      case 'n':
        this.writeInt16(Number(value));
        return;
      case 'q':
        this.writeUInt16(Number(value));
        return;
      case 'b':
        this.writeUInt32(value ? 1 : 0);
        return;
      case 'i':
        this.writeInt32(Number(value));
        return;
      case 'u':
        this.writeUInt32(Number(value));
        return;
      case 'x':
        this.writeInt64(typeof value === 'bigint' ? value : Number(value));
        return;
      case 't':
        this.writeUInt64(typeof value === 'bigint' ? value : Number(value));
        return;
      case 'd':
        this.writeDouble(Number(value));
        return;
      case 's':
      case 'o':
        this.writeString(String(value));
        return;
      case 'g':
        this.writeSignature(String(value));
        return;
      case 'v': {
        const variant = value as DbusVariant;
        this.writeSignature(variant.signature);
        this.writeValue(variant.signature, variant.value);
        return;
      }
      case 'a': {
        const elemType = type.slice(1);
        this.align(4);
        const lenPos = this.pos;
        this.writeUInt32(0);
        this.align(alignmentOf(elemType));
        const start = this.pos;
        if (elemType.startsWith('{') && elemType.endsWith('}')) {
          const [keyType, valType] = splitCompleteTypes(elemType.slice(1, -1));
          if (!keyType || !valType) throw new Error(`Invalid dict entry type: ${elemType}`);
          const record = (value ?? {}) as Record<string, unknown>;
          for (const [k, v] of Object.entries(record)) {
            this.align(8);
            this.writeValue(keyType, k);
            this.writeValue(valType, v);
          }
        } else {
          const items = Array.isArray(value) ? value : [];
          for (const item of items) this.writeValue(elemType, item);
        }
        this.buf.writeUInt32LE(this.pos - start, lenPos);
        return;
      }
      case '(': {
        this.align(8);
        const innerTypes = splitCompleteTypes(type.slice(1, -1));
        const tuple = Array.isArray(value) ? value : [];
        for (let i = 0; i < innerTypes.length; i += 1) {
          this.writeValue(innerTypes[i] as string, tuple[i]);
        }
        return;
      }
      default:
        throw new Error(`Unsupported D-Bus write type: ${type}`);
    }
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.pos));
  }
}

class DbusReader {
  private pos: number;
  private readonly buf: Buffer;
  private readonly le: boolean;

  constructor(buf: Buffer, le: boolean, startOffset = 0) {
    this.buf = buf;
    this.le = le;
    this.pos = startOffset;
  }

  private ensure(n: number): void {
    if (this.pos + n > this.buf.length) throw new RangeError('Truncated D-Bus payload');
  }

  align(n: number): void {
    const target = alignUp(this.pos, n);
    if (target > this.buf.length) throw new RangeError('Truncated D-Bus padding');
    this.pos = target;
  }

  readByte(): number {
    this.ensure(1);
    const v = this.buf[this.pos] as number;
    this.pos += 1;
    return v;
  }

  readInt16(): number {
    this.align(2);
    this.ensure(2);
    const v = this.le ? this.buf.readInt16LE(this.pos) : this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  readUInt16(): number {
    this.align(2);
    this.ensure(2);
    const v = this.le ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  readUInt32(): number {
    this.align(4);
    this.ensure(4);
    const v = this.le ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  readInt32(): number {
    this.align(4);
    this.ensure(4);
    const v = this.le ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  readInt64(): bigint {
    this.align(8);
    this.ensure(8);
    const v = this.le ? this.buf.readBigInt64LE(this.pos) : this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  readUInt64(): bigint {
    this.align(8);
    this.ensure(8);
    const v = this.le ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  readDouble(): number {
    this.align(8);
    this.ensure(8);
    const v = this.le ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }

  readString(): string {
    const len = this.readUInt32();
    this.ensure(len + 1);
    const str = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len + 1;
    return str;
  }

  readSignature(): string {
    const len = this.readByte();
    this.ensure(len + 1);
    const sig = this.buf.toString('ascii', this.pos, this.pos + len);
    this.pos += len + 1;
    return sig;
  }

  readValue(type: string, depth = 0): unknown {
    if (depth > MAX_NESTING_DEPTH) throw new Error('D-Bus value nesting too deep');
    switch (type[0]) {
      case 'y':
        return this.readByte();
      case 'n':
        return this.readInt16();
      case 'q':
        return this.readUInt16();
      case 'b':
        return this.readUInt32() !== 0;
      case 'i':
        return this.readInt32();
      case 'u':
        return this.readUInt32();
      case 'x':
        return this.readInt64();
      case 't':
        return this.readUInt64();
      case 'd':
        return this.readDouble();
      case 's':
      case 'o':
        return this.readString();
      case 'g':
        return this.readSignature();
      case 'v': {
        const nextDepth = depth + 1;
        if (nextDepth > MAX_NESTING_DEPTH) throw new Error('D-Bus variant nesting too deep');
        const sig = this.readSignature();
        const innerTypes = splitCompleteTypes(sig, nextDepth);
        if (innerTypes.length !== 1) {
          throw new Error(`Invalid D-Bus variant signature: '${sig}'`);
        }
        return dbusVariant(sig, this.readValue(innerTypes[0] as string, nextDepth));
      }
      case 'a': {
        const nextDepth = depth + 1;
        if (nextDepth > MAX_NESTING_DEPTH) throw new Error('D-Bus array nesting too deep');
        const elemType = type.slice(1);
        const byteLen = this.readUInt32();
        this.align(alignmentOf(elemType));
        const end = this.pos + byteLen;
        if (end > this.buf.length) throw new RangeError('D-Bus array exceeds message bounds');
        if (elemType.startsWith('{') && elemType.endsWith('}')) {
          const [keyType, valType] = splitCompleteTypes(elemType.slice(1, -1), nextDepth);
          if (!keyType || !valType) throw new Error(`Invalid dict entry type: ${elemType}`);
          const record: Record<string, unknown> = {};
          while (this.pos < end) {
            this.align(8);
            const k = String(this.readValue(keyType, nextDepth));
            const v = this.readValue(valType, nextDepth);
            if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') record[k] = v;
          }
          return record;
        }
        const items: unknown[] = [];
        while (this.pos < end) items.push(this.readValue(elemType, nextDepth));
        return items;
      }
      case '(': {
        const nextDepth = depth + 1;
        if (nextDepth > MAX_NESTING_DEPTH) throw new Error('D-Bus struct nesting too deep');
        this.align(8);
        return splitCompleteTypes(type.slice(1, -1), nextDepth).map((t) =>
          this.readValue(t, nextDepth),
        );
      }
      default:
        throw new Error(`Unsupported D-Bus read type: ${type}`);
    }
  }
}

/** Encodes a D-Bus 1.0 message into a little-endian wire `Buffer`. */
export function encodeDbusMessage(msg: DbusMessage): Buffer {
  const bodyWriter = new DbusWriter();
  const signature = msg.signature ?? '';
  if (signature.length > 0) {
    const types = splitCompleteTypes(signature);
    for (let i = 0; i < types.length; i += 1) {
      bodyWriter.writeValue(types[i] as string, msg.body[i]);
    }
  }
  const bodyBuf = bodyWriter.toBuffer();

  const headerFields: Array<[number, DbusVariant]> = [];
  if (msg.path !== undefined) {
    headerFields.push([DBUS_HEADER_FIELD.PATH, dbusVariant('o', msg.path)]);
  }
  if (msg.interface !== undefined) {
    headerFields.push([DBUS_HEADER_FIELD.INTERFACE, dbusVariant('s', msg.interface)]);
  }
  if (msg.member !== undefined) {
    headerFields.push([DBUS_HEADER_FIELD.MEMBER, dbusVariant('s', msg.member)]);
  }
  if (msg.errorName !== undefined) {
    headerFields.push([DBUS_HEADER_FIELD.ERROR_NAME, dbusVariant('s', msg.errorName)]);
  }
  if (msg.replySerial !== undefined) {
    headerFields.push([DBUS_HEADER_FIELD.REPLY_SERIAL, dbusVariant('u', msg.replySerial)]);
  }
  if (msg.destination !== undefined) {
    headerFields.push([DBUS_HEADER_FIELD.DESTINATION, dbusVariant('s', msg.destination)]);
  }
  if (msg.sender !== undefined) {
    headerFields.push([DBUS_HEADER_FIELD.SENDER, dbusVariant('s', msg.sender)]);
  }
  if (signature.length > 0) {
    headerFields.push([DBUS_HEADER_FIELD.SIGNATURE, dbusVariant('g', signature)]);
  }

  const writer = new DbusWriter();
  writer.writeByte(LITTLE_ENDIAN);
  writer.writeByte(msg.type);
  writer.writeByte(msg.flags);
  writer.writeByte(1);
  writer.writeUInt32(bodyBuf.length);
  writer.writeUInt32(msg.serial);
  writer.writeValue('a(yv)', headerFields);
  writer.align(8);
  const headerBuf = writer.toBuffer();
  return bodyBuf.length > 0 ? Buffer.concat([headerBuf, bodyBuf]) : headerBuf;
}

/**
 * Attempts to decode one complete D-Bus 1.0 message from the start of `buf`.
 * Returns `null` when more bytes are needed; throws on invalid framing or oversized frames.
 */
export function tryDecodeDbusMessage(
  buf: Buffer,
): { readonly message: DbusMessage; readonly bytesRead: number } | null {
  if (buf.length < 16) return null;
  const endian = buf[0];
  if (endian !== LITTLE_ENDIAN && endian !== BIG_ENDIAN) {
    throw new Error(`Invalid D-Bus endian byte: ${String(endian)}`);
  }
  const le = endian === LITTLE_ENDIAN;
  const type = buf[1] as number;
  const flags = buf[2] as number;
  const version = buf[3] as number;
  if (version !== 1) throw new Error(`Unsupported D-Bus protocol version: ${version}`);
  const bodyLen = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const serial = le ? buf.readUInt32LE(8) : buf.readUInt32BE(8);
  const fieldsLen = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const bodyStart = alignUp(16 + fieldsLen, 8);
  const totalLen = bodyStart + bodyLen;
  if (totalLen > MAX_MESSAGE_BYTES) {
    throw new Error(`D-Bus message size ${totalLen} exceeds limit ${MAX_MESSAGE_BYTES}`);
  }
  if (buf.length < totalLen) return null;

  const reader = new DbusReader(buf.subarray(0, totalLen), le, 12);
  const rawFields = reader.readValue('a(yv)') as Array<[number, DbusVariant]>;
  let path: string | undefined;
  let iface: string | undefined;
  let member: string | undefined;
  let errorName: string | undefined;
  let replySerial: number | undefined;
  let destination: string | undefined;
  let sender: string | undefined;
  let signature: string | undefined;

  for (const [code, variant] of rawFields) {
    switch (code) {
      case DBUS_HEADER_FIELD.PATH:
        path = String(variant.value);
        break;
      case DBUS_HEADER_FIELD.INTERFACE:
        iface = String(variant.value);
        break;
      case DBUS_HEADER_FIELD.MEMBER:
        member = String(variant.value);
        break;
      case DBUS_HEADER_FIELD.ERROR_NAME:
        errorName = String(variant.value);
        break;
      case DBUS_HEADER_FIELD.REPLY_SERIAL:
        replySerial = Number(variant.value);
        break;
      case DBUS_HEADER_FIELD.DESTINATION:
        destination = String(variant.value);
        break;
      case DBUS_HEADER_FIELD.SENDER:
        sender = String(variant.value);
        break;
      case DBUS_HEADER_FIELD.SIGNATURE:
        signature = String(variant.value);
        break;
    }
  }

  const body: unknown[] = [];
  if (signature && signature.length > 0 && bodyLen > 0) {
    const bodyReader = new DbusReader(buf.subarray(bodyStart, totalLen), le, 0);
    for (const t of splitCompleteTypes(signature)) body.push(bodyReader.readValue(t));
  }

  return {
    bytesRead: totalLen,
    message: {
      type,
      flags,
      serial,
      ...(path !== undefined ? { path } : {}),
      ...(iface !== undefined ? { interface: iface } : {}),
      ...(member !== undefined ? { member } : {}),
      ...(errorName !== undefined ? { errorName } : {}),
      ...(replySerial !== undefined ? { replySerial } : {}),
      ...(destination !== undefined ? { destination } : {}),
      ...(sender !== undefined ? { sender } : {}),
      ...(signature !== undefined ? { signature } : {}),
      body,
    },
  };
}
