// Copyright 2013 Google Inc. All rights reserved.
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Low-level communications with the RTL2832U-base dongle.
 */
class RtlCom {
    constructor(device: USBDevice) {
        this.device = device;
    }

    private device: USBDevice;

    /** Set in the control messages' index field for write operations. */
    private static WRITE_FLAG = 0x10;

    /** Claims the USB control interface. */
    async claimInterface() {
        await this.device.claimInterface(0);
    }

    /**
     * Releases the USB control interface.
     */
    async releaseInterface() {
        await this.device.releaseInterface(0);
    }

    /**
     * Writes to a USB control register.
     * @param address The register's address.
     * @param value The value to write.
     * @param length The number of bytes this value uses.
     */
    async setUsbReg(address: number, value: number, length: number) {
        await this._setReg(0x100, address, value, length);
    }

    /**
     * Writes to a 8051 system register.
     * @param address The register's address.
     * @param value The value to write.
     * @param length The number of bytes this value uses.
     */
    async setSysReg(address: number, value: number) {
        await this._setReg(0x200, address, value, 1);
    }

    /**
     * Writes a value into a demodulator register.
     * @param page The register page number.
     * @param addr The register's address.
     * @param value The value to write.
     * @param len The width in bytes of this value.
     * @returns a promise that resolves the value that was read back from the register.
     */
    async setDemodReg(page: number, addr: number, value: number, len: number): Promise<number> {
        await this._setRegBuffer(page, (addr << 8) | 0x20, this._numberToBuffer(value, len, true));
        return this._getReg(0x0a, 0x0120, 1);
    }

    /**
     * Reads a value from an I2C register.
     * @param addr The device's address.
     * @param reg The register number.
     * @returns a promise that resolves to the value in the register.
     */
    async getI2CReg(addr: number, reg: number): Promise<number> {
        await this._setRegBuffer(0x600, addr, new Uint8Array([reg]).buffer);
        return this._getReg(0x600, addr, 1);
    }

    /**
     * Writes a value to an I2C register.
     * @param addr The device's address.
     * @param reg The register number.
     * @param value The value to write.
     */
    async setI2CReg(addr: number, reg: number, value: number) {
        await this._setRegBuffer(0x600, addr, new Uint8Array([reg, value]).buffer);
    }

    /**
     * Reads a buffer from an I2C register.
     * @param addr The device's address.
     * @param reg The register number.
     * @param len The number of bytes to read.
     * @returns a promise that resolves to the read buffer.
     */
    async getI2CRegBuffer(addr: number, reg: number, len: number): Promise<ArrayBuffer> {
        await this._setRegBuffer(0x600, addr, new Uint8Array([reg]).buffer);
        return this._getRegBuffer(0x600, addr, len);
    }

    /**
     * Does a bulk transfer from the device.
     * @param length The number of bytes to read.
     * @returns a promise that resolves to the data that was read.
     */
    async getSamples(length: number): Promise<ArrayBuffer> {
        let result = await this.device.transferIn(1, length);
        let rc = result.status;
        if (rc == 'ok' && result.data !== undefined) return result.data.buffer;
        if (rc == 'stall') {
            await this.device.clearHalt('in', 1);
            return new ArrayBuffer(length);
        }
        throw 'USB bulk read failed (length 0x' + length.toString(16) + '), rc=' + rc;
    }

    /**
     * Opens the I2C repeater.
     * To avoid interference, the tuner is usually disconnected from the I2C bus.
     * With the repeater open, the tuner can receive I2C messages.
     */
    async openI2C() {
        await this.setDemodReg(1, 1, 0x18, 1);
    }

    /**
     * Closes the I2C repeater.
     */
    async closeI2C() {
        await this.setDemodReg(1, 1, 0x10, 1);
    }

    /**
     * Writes a value into a dongle's register.
     * @param block The register's block number.
     * @param reg The register number.
     * @param value The value to write.
     * @param length The width in bytes of this value.
     */
    private async _setReg(block: number, reg: number, value: number, length: number) {
        await this._writeCtrlMsg(reg, block | RtlCom.WRITE_FLAG, this._numberToBuffer(value, length));
    }

    /**
     * Reads a value from a dongle's register.
     * @param block The register's block number.
     * @param reg The register number.
     * @param length The width in bytes of the value to read.
     * @returns a promise that resolves to the decoded value.
     */
    private async _getReg(block: number, reg: number, length: number): Promise<number> {
        return this._bufferToNumber(await this._readCtrlMsg(reg, block, length));
    }

    /**
     * Writes a buffer into a dongle's register.
     * @param block The register's block number.
     * @param reg The register number.
     * @param buffer The buffer to write.
     */
    private async _setRegBuffer(block: number, reg: number, buffer: ArrayBuffer) {
        await this._writeCtrlMsg(reg, block | RtlCom.WRITE_FLAG, buffer);
    }

    /**
     * Reads a buffer from a dongle's register.
     * @param block The register's block number.
     * @param reg The register number.
     * @param length The length in bytes of the buffer to read.
     * @returns a Promise that resolves to the read buffer.
     */
    private async _getRegBuffer(block: number, reg: number, length: number): Promise<ArrayBuffer> {
        return this._readCtrlMsg(reg, block, length);
    }

    /**
     * Decodes a buffer as a little-endian number.
     * @param buffer The buffer to decode.
     * @return The decoded number.
     */
    private _bufferToNumber(buffer: ArrayBuffer): number {
        let len = buffer.byteLength;
        let dv = new DataView(buffer);
        if (len == 0) {
            return 0;
        } else if (len == 1) {
            return dv.getUint8(0);
        } else if (len == 2) {
            return dv.getUint16(0, true);
        } else if (len == 4) {
            return dv.getUint32(0, true);
        }
        throw 'Cannot parse ' + len + '-byte number';
    }

    /**
     * Encodes a number into a buffer.
     * @param value The number to encode.
     * @param len The number of bytes to encode into.
     * @param opt_bigEndian Whether to use a big-endian encoding.
     */
    private _numberToBuffer(value: number, len: number, opt_bigEndian?: boolean) {
        let buffer = new ArrayBuffer(len);
        let dv = new DataView(buffer);
        if (len == 1) {
            dv.setUint8(0, value);
        } else if (len == 2) {
            dv.setUint16(0, value, !opt_bigEndian);
        } else if (len == 4) {
            dv.setUint32(0, value, !opt_bigEndian);
        } else {
            throw 'Cannot write ' + len + '-byte number';
        }
        return buffer;
    }

    /**
     * Sends a USB control message to read from the device.
     * @param value The value field of the control message.
     * @param index The index field of the control message.
     * @param length The number of bytes to read.
     * @returns a promise that resolves to the read buffer.
     */
    private async _readCtrlMsg(value: number, index: number, length: number): Promise<ArrayBuffer> {
        let ti: USBControlTransferParameters = {
            requestType: 'vendor',
            recipient: 'device',
            request: 0,
            value: value,
            index: index
        };
        let result = await this.device.controlTransferIn(ti, Math.max(8, length));
        let rc = result.status;
        if (rc == 'ok' && result.data !== undefined) return result.data.buffer.slice(0, length);
        throw 'USB read failed (value 0x' + value.toString(16) + ' index 0x' + index.toString(16) + '), rc=' + rc;
    }

    /**
     * Sends a USB control message to write to the device.
     * @param value The value field of the control message.
     * @param index The index field of the control message.
     * @param buffer The buffer to write to the device.
     */
    private async _writeCtrlMsg(value: number, index: number, buffer: ArrayBuffer) {
        let ti: USBControlTransferParameters = {
            requestType: 'vendor',
            recipient: 'device',
            request: 0,
            value: value,
            index: index
        };
        let result = await this.device.controlTransferOut(ti, buffer);
        let rc = result.status;
        if (rc == 'ok') return;
        throw 'USB write failed (value 0x' + value.toString(16) + ' index 0x' + index.toString(16) + ' data ' + this._dumpBuffer(buffer) + '), rc=' + rc;
    }

    /**
     * Returns a string representation of a buffer.
     * @param buffer The buffer to display.
     * @return The string representation of the buffer.
     */
    private _dumpBuffer(buffer: ArrayBuffer): string {
        let bytes: string[] = [];
        let arr = new Uint8Array(buffer);
        for (let i = 0; i < arr.length; ++i) {
            bytes.push('0x' + arr[i].toString(16));
        }
        return '[' + bytes.join(', ') + ']';
    }
}


