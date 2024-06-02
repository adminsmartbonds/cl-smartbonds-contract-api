# smartbonds-api
SmartBonds Contract API layer 

Our APIs are targetted at Google Functions though with very little change you should be able to run this code on most 
clouds that support running express inside their serverless setup and setting variables through the environment.

- The contract API currently only holds some simple logic to deploy a signed contract to a blockchain.
- We've kept the environment settings for testing private as it contains some keys and pwds so if you need instrucions 
on how to set that up, ask. 
- For local running you may also need to tweak some of the values in the .env file.
- For dates we will be storing all dates in UTC in the DB, makes things easier

TODOs (at least those I can think of)
- Need to add error codes to all the log entries
- Need to add trace IDs to the flow, though need to figure out how to do that through the cloud stack.
- Need to create a bunch of tests.
