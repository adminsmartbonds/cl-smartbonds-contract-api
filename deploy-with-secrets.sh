#!/bin/bash
#
# This script is meant to make the job of deploying Google Functions with secrets easier
# The file will read an environment file with environment variables mapped to their secret reference
# and will constructre the resulting --set-secrets parameters for the cloud deployment command.
#
if [ $# -ne 3 ]; then
  echo "Invalid number of parameters"
  echo "You must pass the secrets file as a parameter."
  echo "The file is a set of SECRET_NAME=SECRET_REFERENCE"
  echo "The SECRET_REFERENCE is of the form projects/<project id>/secrets/<secret name>:<secret version>"
  echo "You must also pass the name of the function and its entry point"
  echo "The parameters passed were: " "$@"
  exit 100;
fi

echo "********************************************************************"
echo "* Make sure that the account running your functions has permission *"
echo "* to access the secrets. You must give the account the role:       *"
echo "* Secrets Manager Secret Accessor for each of the keys             *"
echo "********************************************************************"

SECRETS_CONTENT=$(grep -v '^#' "$1" | paste -sd, -)
gcloud functions deploy "$2" \
  --gen2 --region=northamerica-northeast1 --runtime=nodejs20 \
  --source=. --entry-point="$3" --trigger-http \
  --env-vars-file=env.vars.dev.yaml \
  --set-secrets="$SECRETS_CONTENT"
