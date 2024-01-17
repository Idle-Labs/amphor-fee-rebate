module.exports = class Multicall {

  constructor(web3=null) {
    this.contractAddress = '0xcA11bde05977b3631167028862bE2a173976CA11';
    if (web3){
      this.setWeb3(web3);
    }
  }

  setWeb3(web3) {
    this.web3 = web3;
  }

  getCallData(contract, methodName, params=[], extraData={}) {
    const methodAbi = contract._jsonInterface.find(f => f.name === methodName && f.inputs.length === params.length);
    if (!methodAbi){
      return null;
    }
    const inputTypes = methodAbi.inputs.map( i => i.type );
    const returnTypes = methodAbi.outputs.map( i => i.type );
    const returnFields = methodAbi.outputs.map( i => i.name );

    if (contract._address === '0x0000000000000000000000000000000000000000'){
      return null;
    }

    const checkAddress = (address) => {
      return address ? address.match(/^0x[a-fA-F0-9]{40}$/) !== null : false;
    }

    const args = params.map( (p,i) => {
      const inputType = inputTypes[i];
      if (inputType === 'address' && !checkAddress(p)){
        p = '0x0000000000000000000000000000000000000000';
      }
      return [p].concat(inputType);
    });

    return {
      args,
      extraData,
      returnFields,
      returnTypes,
      target:contract._address,
      method:methodName+'('+inputTypes.join(',')+')',
      rawCall:contract.methods[methodName](...params)
    };
  }

  prepareMulticallData(calls,web3=null) {

    web3 = this.web3 || web3;

    if (!web3){
      return false;
    }

    const strip0x = (str) => {
      return str.replace(/^0x/, '');
    }

    const values = [
      calls.map(({ target, method, args, returnTypes }) => {
        return [
          target,
          web3.utils.keccak256(method).substr(0, 10) +
            (args && args.length > 0
              ? strip0x(web3.eth.abi.encodeParameters(args.map(a => a[1]), args.map(a => a[0])))
              : '')
        ];
      })
    ];
    const calldata = web3.eth.abi.encodeParameters(
      [
        {
          components: [{ type: 'address' }, { type: 'bytes' }],
          name: 'data',
          type: 'tuple[]'
        }
      ],
      values
    );

    return '0x252dba42'+strip0x(calldata);
  }

  async executeMultipleBatches(callBatches, web3=null, blockNumber='latest') {
    const calls = [];
    callBatches.forEach( (batchedCalls,batchId) => {
      batchedCalls.forEach( call => {
        call.batchId = batchId;
        calls.push(call);
      });
    });
    
    const results = await this.executeMulticalls(calls, web3, blockNumber);

    return results ? results.reduce( (output,r) => {
      const batchId = r.callData.batchId;
      if (!output[batchId]){
        output[batchId] = [];
      }
      output[batchId].push(r);
      return output;
    },[]) : [];
  }

  catchEm(promise) {
    return promise.then(data => [null,data])
      .catch(err => [err,null]);
  }

  async executeMulticalls(calls, web3=null, blockNumber='latest') {

    web3 = this.web3 || web3;

    const calldata = this.prepareMulticallData(calls, web3);

    // console.log('executeMulticalls', web3, calldata)

    if (!calldata){
      return null;
    }

    let decodedResults = [];

    try {
      const results = await web3.eth.call({
        data: calldata,
        to:this.contractAddress
      }, parseInt(blockNumber));

      // console.log('executeMulticalls', results)

      const decodedParams = web3.eth.abi.decodeParameters(['uint256', 'bytes[]'], results);

      if (decodedParams && typeof decodedParams[1] !== 'undefined'){
        decodedResults = decodedParams[1];

        if (decodedResults && decodedResults.length){
          return decodedResults.map( (d,i) => {
            const output = {
              data:null,
              callData:calls[i],
              ...calls[i].extraData
            };
            const returnTypes = calls[i].returnTypes;
            const returnFields = calls[i].returnFields;
            const decodedValues = Object.values(web3.eth.abi.decodeParameters(returnTypes,d));
            if (returnTypes.length === 1){
              output.data = decodedValues[0];
            } else {
              const values = decodedValues.splice(0,returnTypes.length);
              output.data = values ? values.reduce( (acc,v,j) => {
                acc[j] = v;
                acc[returnFields[j]] = v;
                return acc;
              },{}) : {};
            }
            return output;
          });
        }
      }
    } catch (err) {

      console.error(err);

      for (let i=0; i<calls.length; i++){
        const output = {
          data:null,
          callData:calls[i],
          ...calls[i].extraData
        };
        const [err,result] = await this.catchEm(calls[i].rawCall.call());
        if (result){
          output.data = result;
        }
        decodedResults.push(output);
      }

      return decodedResults;
    }

    return null;
  }
}