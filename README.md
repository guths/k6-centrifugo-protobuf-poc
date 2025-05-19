
# Run docker image

``` bash
docker compose up -d
```

## Explaining files 

- `newcentrifugo.js` - .proto file transformed to JS using `pbjs`.
- `protobuf.js` - external library that I import intenally to use protobuf and avoid problems with k6.
- `broadcast_proto.js` - k6 script that uses protobuf to send messages to Centrifugo.

# Protobuf Centrifugo K6
``` bash
# Run the test
k6 run --env CENTRIFUGO_WS_URL="ws://localhost:8000/connection/websocket" \      105 ✘ │ 20.19.2  │ 11:08:03  
       --summary-export=summary.json \
       --env JWT_SECRET=bbe7d157-a253-4094-9759-06a8236543f9 \
       --env EXTRA_CHANNELS_AMOUNT=0 \
       --env USER_PER_EXTRA_CHANNEL=0 \
       --env VUS=2 \
       --env CENTRIFUGO_API_URL=http://localhost:8000/api/broadcast \
       --env API_KEY=my_api_key \
       broadcast_proto.js
       ```


