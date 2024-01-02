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
 * Operations on the R820T tuner chip.
 */
class R820T {
  /**
   * @param {RtlCom} com The RTL communications object.
   * @param {number} xtalFreq The frequency of the oscillator crystal.
   */
  constructor(com, xtalFreq) {
    this.com = com;
    this.xtalFreq = xtalFreq;
    this.hasPllLock = false;
  }

  /**
   * Initial values for registers 0x05-0x1f.
   */
  static REGISTERS = [0x83, 0x32, 0x75, 0xc0, 0x40, 0xd6, 0x6c, 0xf5, 0x63, 0x75,
    0x68, 0x6c, 0x83, 0x80, 0x00, 0x0f, 0x00, 0xc0, 0x30, 0x48,
    0xcc, 0x60, 0x00, 0x54, 0xae, 0x4a, 0xc0];

  /**
   * Configurations for the multiplexer in different frequency bands.
   */
  static MUX_CFGS = [
    [0, 0x08, 0x02, 0xdf],
    [50, 0x08, 0x02, 0xbe],
    [55, 0x08, 0x02, 0x8b],
    [60, 0x08, 0x02, 0x7b],
    [65, 0x08, 0x02, 0x69],
    [70, 0x08, 0x02, 0x58],
    [75, 0x00, 0x02, 0x44],
    [90, 0x00, 0x02, 0x34],
    [110, 0x00, 0x02, 0x24],
    [140, 0x00, 0x02, 0x14],
    [180, 0x00, 0x02, 0x13],
    [250, 0x00, 0x02, 0x11],
    [280, 0x00, 0x02, 0x00],
    [310, 0x00, 0x41, 0x00],
    [588, 0x00, 0x40, 0x00]
  ];

  /**
   * A bit mask to reverse the bits in a byte.
   */
  static BIT_REVS = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe,
    0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];

  /** @type {RtlCom} The RTL communications object. */
  com;

  /** @type {number} The frequency of the oscillator crystal. */
  xtalFreq;


  /** @type {boolean} Whether the PLL in the tuner is locked. */
  hasPllLock;

  /** @type {Uint8Array|undefined} Shadow registers 0x05-0x1f, for setting values using masks. */
  shadowRegs;

  /**
   * Checks if the R820T tuner is present.
   * @param {RtlCom} com The RTL communications object.
   * @returns {Promise<bool>} a promise that resolves to whether the tuner is present.
   */
  static async check(com) {
    let data = await com.readI2CRegister(0x34, 0);
    return data == 0x69;
  }

  /**
   * Initializes the tuner.
   * @returns {Promise<void>}
   */
  async init() {
    await this._initRegisters(R820T.REGISTERS);
    await this._initElectronics();
  }

  /**
   * Sets the tuner's frequency.
   * @param {number} freq The frequency to tune to.
   * @returns {Promise<number>} a promise that resolves to the actual tuned frequency.
   */
  async setFrequency(freq) {
    await this._setMux(freq);
    return this._setPll(freq);
  }

  /**
   * Stops the tuner.
   * @returns {Promise<void>}
   */
  async close() {
    await this._writeEach([
      [0x06, 0xb1, 0xff],
      [0x05, 0xb3, 0xff],
      [0x07, 0x3a, 0xff],
      [0x08, 0x40, 0xff],
      [0x09, 0xc0, 0xff],
      [0x0a, 0x36, 0xff],
      [0x0c, 0x35, 0xff],
      [0x0f, 0x68, 0xff],
      [0x11, 0x03, 0xff],
      [0x17, 0xf4, 0xff],
      [0x19, 0x0c, 0xff]
    ]);
  }

  /**
   * Sets the tuner to automatic gain.
   * @returns {Promise<void>}
   */
  async setAutoGain() {
    await this._writeEach([
      [0x05, 0x00, 0x10],
      [0x07, 0x10, 0x10],
      [0x0c, 0x0b, 0x9f]
    ]);
  }

  /**
   * Sets the tuner's manual gain.
   * @param {number} gain The tuner's gain, in dB.
   * @returns {Promise<void>}
   */
  async setManualGain(gain) {
    let step = 0;
    if (gain <= 15) {
      step = Math.round(1.36 + gain * (1.1118 + gain * (-0.0786 + gain * 0.0027)));
    } else {
      step = Math.round(1.2068 + gain * (0.6875 + gain * (-0.01011 + gain * 0.0001587)));
    }
    if (step < 0) {
      step = 0;
    } else if (step > 30) {
      step = 30;
    }
    let lnaValue = Math.floor(step / 2);
    let mixerValue = Math.floor((step - 1) / 2);
    await this._writeEach([
      [0x05, 0x10, 0x10],
      [0x07, 0x00, 0x10],
      [0x0c, 0x08, 0x9f],
      [0x05, lnaValue, 0x0f],
      [0x07, mixerValue, 0x0f]
    ]);
  }

  /**
   * Calibrates the filters.
   * @returns {Promise<void>}
   */
  async _calibrateFilter() {
    let firstTry = true;
    while (true) {
      await this._writeEach([
        [0x0b, 0x6b, 0x60],
        [0x0f, 0x04, 0x04],
        [0x10, 0x00, 0x03]
      ]);
      await this._setPll(56000000);
      if (!this.hasPllLock) {
        throw "PLL not locked -- cannot tune to the selected frequency.";
      }
      await this._writeEach([
        [0x0b, 0x10, 0x10],
        [0x0b, 0x00, 0x10],
        [0x0f, 0x00, 0x04]
      ]);
      let data = await this._readRegBuffer(0x00, 5);
      let arr = new Uint8Array(data);
      let filterCap = arr[4] & 0x0f;
      if (filterCap == 0x0f) {
        filterCap = 0;
      }
      if (filterCap == 0 || !firstTry) {
        return filterCap;
      }
      firstTry = false;
    }
  }

  /**
   * Sets the multiplexer's frequency.
   * @param {number} freq The frequency to set.
   * @returns {Promise<void>}
   */
  async _setMux(freq) {
    let freqMhz = freq / 1000000;
    let i;
    for (i = 0; i < R820T.MUX_CFGS.length - 1; ++i) {
      if (freqMhz < R820T.MUX_CFGS[i + 1][0]) {
        break;
      }
    }
    let cfg = R820T.MUX_CFGS[i];
    await this._writeEach([
      [0x17, cfg[1], 0x08],
      [0x1a, cfg[2], 0xc3],
      [0x1b, cfg[3], 0xff],
      [0x10, 0x00, 0x0b],
      [0x08, 0x00, 0x3f],
      [0x09, 0x00, 0x3f]
    ]);
  }

  /**
   * Sets the PLL's frequency.
   * @param {number} freq The frequency to set.
   * @returns {Promise<number>} a promise that resolves to the actual frequency set, or to undefined if the frequency is not achievable.
   */
  async _setPll(freq) {
    let pllRef = Math.floor(this.xtalFreq);
    await this._writeEach([
      [0x10, 0x00, 0x10],
      [0x1a, 0x00, 0x0c],
      [0x12, 0x80, 0xe0]
    ]);
    let divNum = Math.min(6, Math.floor(Math.log(1770000000 / freq) / Math.LN2));
    let mixDiv = 1 << (divNum + 1);
    let data = await this._readRegBuffer(0x00, 5);
    let arr = new Uint8Array(data);
    let vcoFineTune = (arr[4] & 0x30) >> 4;
    if (vcoFineTune > 2) {
      --divNum;
    } else if (vcoFineTune < 2) {
      ++divNum;
    }
    await this._writeRegMask(0x10, divNum << 5, 0xe0);
    let vcoFreq = freq * mixDiv;
    let nint = Math.floor(vcoFreq / (2 * pllRef));
    let vcoFra = vcoFreq % (2 * pllRef);
    if (nint > 63) {
      this.hasPllLock = false;
      return;
    }
    let ni = Math.floor((nint - 13) / 4);
    let si = (nint - 13) % 4;
    await this._writeEach([
      [0x14, ni + (si << 6), 0xff],
      [0x12, vcoFra == 0 ? 0x08 : 0x00, 0x08]
    ]);
    let sdm = Math.min(65535, Math.floor(32768 * vcoFra / pllRef));
    await this._writeEach([
      [0x16, sdm >> 8, 0xff],
      [0x15, sdm & 0xff, 0xff]
    ]);
    await this._getPllLock();
    await this._writeRegMask(0x1a, 0x08, 0x08);
    return 2 * pllRef * (nint + sdm / 65536) / mixDiv;
  }

  /**
   * Checks whether the PLL has achieved lock.
   * @param {boolean} firstTry Whether this is the first try to achieve lock.
   * @returns {Promise<void>}
   */
  async _getPllLock() {
    let firstTry = true;
    while (true) {
      let data = await this._readRegBuffer(0x00, 3);
      let arr = new Uint8Array(data);
      if (arr[2] & 0x40) {
        this.hasPllLock = true;
        return;
      }
      if (!firstTry) {
        this.hasPllLock = true;
        return;
      }
      await this._writeRegMask(0x12, 0x60, 0xe0);
      firstTry = false;
    }
  }

  /**
   * Sets the initial values of the 0x05-0x1f registers.
   * @param {Array.<number>} regs The values for the registers.
   * @returns {Promise<void>}
   */
  async _initRegisters(regs) {
    this.shadowRegs = new Uint8Array(regs);
    let cmds = [];
    for (let i = 0; i < regs.length; ++i) {
      cmds.push([CMD.I2CREG, 0x34, i + 5, regs[i]]);
    }
    await this.com.writeEach(cmds);
  }

  /**
   * Initializes all the components of the tuner.
   * @returns {Promise<void>}
   */
  async _initElectronics() {
    await this._writeEach([
      [0x0c, 0x00, 0x0f],
      [0x13, 49, 0x3f],
      [0x1d, 0x00, 0x38]
    ]);
    let filterCap = await this._calibrateFilter();
    await this._writeEach([
      [0x0a, 0x10 | filterCap, 0x1f],
      [0x0b, 0x6b, 0xef],
      [0x07, 0x00, 0x80],
      [0x06, 0x10, 0x30],
      [0x1e, 0x40, 0x60],
      [0x05, 0x00, 0x80],
      [0x1f, 0x00, 0x80],
      [0x0f, 0x00, 0x80],
      [0x19, 0x60, 0x60],
      [0x1d, 0xe5, 0xc7],
      [0x1c, 0x24, 0xf8],
      [0x0d, 0x53, 0xff],
      [0x0e, 0x75, 0xff],
      [0x05, 0x00, 0x60],
      [0x06, 0x00, 0x08],
      [0x11, 0x38, 0x08],
      [0x17, 0x30, 0x30],
      [0x0a, 0x40, 0x60],
      [0x1d, 0x00, 0x38],
      [0x1c, 0x00, 0x04],
      [0x06, 0x00, 0x40],
      [0x1a, 0x30, 0x30],
      [0x1d, 0x18, 0x38],
      [0x1c, 0x24, 0x04],
      [0x1e, 0x0d, 0x1f],
      [0x1a, 0x20, 0x30]
    ]);
  }

  /**
   * Reads a series of registers into a buffer.
   * @param {number} addr The first register's address to read.
   * @param {number} length The number of registers to read.
   * @returns {Promise<ArrayBuffer>} a promise that resolves to an ArrayBuffer with the data.
   */
  async _readRegBuffer(addr, length) {
    let data = await this.com.readI2CRegBuffer(0x34, addr, length);
    let buf = new Uint8Array(data);
    for (let i = 0; i < buf.length; ++i) {
      let b = buf[i];
      buf[i] = (R820T.BIT_REVS[b & 0xf] << 4) | R820T.BIT_REVS[b >> 4];
    }
    return buf.buffer;
  }

  /**
   * Writes a masked value into a register.
   * @param {number} addr The address of the register to write into.
   * @param {number} value The value to write.
   * @param {number} mask A mask that specifies which bits to write.
   * @returns {Promise<void>}
   */
  async _writeRegMask(addr, value, mask) {
    let rc = this.shadowRegs[addr - 5];
    let val = (rc & ~mask) | (value & mask);
    this.shadowRegs[addr - 5] = val;
    await this.com.writeI2CRegister(0x34, addr, val);
  }

  /**
   * Perform the write operations given in the array.
   * @param {Array.<Array.<number>>} array The operations.
   * @returns {Promise<void>}
   */
  async _writeEach(array) {
    for (let line of array) {
      await this._writeRegMask(line[0], line[1], line[2]);
    }
  }

  // return {
  //   init: init,
  //   setFrequency: setFrequency,
  //   setAutoGain: setAutoGain,
  //   setManualGain: setManualGain,
  //   close: close
  // };
}
